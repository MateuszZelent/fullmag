"use client";

import type { EChartsOption } from "echarts";
import {
  Activity,
  Compass,
  Cpu,
  Database,
  FileOutput,
  Gauge,
  Info,
  Magnet,
  Play,
  Radar,
  Timer,
  Waves,
  Workflow,
  Zap,
} from "lucide-react";
import { useCallback, useContext, useMemo, useState, type ReactElement } from "react";

import type {
  JsonObject,
  JsonValue,
  RegionalFieldDriveResource,
  SceneResource,
} from "@/kernel/api/apiTypes";
import { KernelContext } from "@/kernel/KernelContext";
import {
  useHysteresisAdaptiveRefinementResource,
  useHysteresisBookmarksResource,
  useHysteresisBranchesResource,
  useHysteresisExecutionTreeResource,
  useHysteresisFamilyResource,
  useHysteresisMetricsResource,
  useHysteresisMinorLoopsResource,
  useHysteresisOrientationResource,
  useHysteresisPointResource,
  useHysteresisPointsResource,
  useHysteresisProgressResource,
  useHysteresisProtocolResource,
  useHysteresisReversalFieldsResource,
  useHysteresisSaturationResource,
  useHysteresisSettlePipelineResource,
  useHysteresisSettleTraceResource,
  useHysteresisStagePlanResource,
  useHysteresisStageSaturationResource,
  useHysteresisStageSettleTraceResource,
} from "@/kernel/resources/studyRuntimeResources";
import type { ActiveLaneCapabilitySnapshot } from "@/kernel/resources/useActiveLaneCapabilities";
import type { StageInitialStateChoice } from "@/kernel/runtime/studyStageInitialState";
import type { Selection } from "@/kernel/selection/selectionTypes";
import type { KernelApi } from "@/kernel/types";
import {
  ScientificEChart,
  type ResolvedChartThemePalette,
} from "@/shared/charts/ScientificEChart";
import { validateFieldDriveDraft } from "@/shared/domain/physics/fieldDrive";
import { buildSincPulsePreview } from "@/shared/domain/physics/sincPulsePreview";
import { antennaFieldSolveDefinitionPortError } from "@/shared/domain/study/antennaFieldSolveCapability";
import { hysteresisTargetMetadataFromOrientation } from "@/shared/domain/study/HysteresisChart";
import { Button } from "@/shared/ui/Button";
import { Switch } from "@/shared/ui/Switch";

import type { InspectorPanelProps } from "../../inspectorTypes";
import {
  inspectorValuesEqual,
  type InspectorFact,
  type InspectorNotice,
  type InspectorSectionSpec,
  type InspectorSpec,
} from "../../template";
import {
  regionalFieldDriveSamplingContext,
  regionalFieldDriveSelectorOptions,
} from "../RegionalFieldDrivePanelModel";
import type { StageAutosaveDraft } from "../StageAutosaveDraft";
import type { StudyStageModel } from "../StudyInspectorPanelModel";
import {
  antennaFieldSolvePortReferences,
  createDefaultStudyStageDraft,
  readStageTextureAssignments,
  relaxationAlgorithmAvailability,
  validateStudyStageDraft,
  type StudyStageDraft,
} from "../StudyStageAuthoringModel";
import {
  ANGLE_RAD_UNITS_SI,
  computeSamplingPlanMetrics,
  ENERGY_JOULE_UNITS_SI,
  FIELD_TESLA_UNITS_SI,
  formatBytesBinary,
  formatFrequencyCompact,
  formatTimeCompact,
  FREQUENCY_UNITS_SI,
  LENGTH_UNITS_SI,
  PipelineStrip,
  SamplingPlanCard,
  TIME_UNITS_SI,
  TORQUE_APM_UNITS_SI,
  type PipelineStripStep,
} from "../study/ConnectedInspectorSpec";
import { useKernelStudyAuthoring } from "../study/useConnectedStudyAuthoring";
import { HysteresisAdaptiveRefinementInspector } from "./hysteresis/HysteresisAdaptiveRefinementInspector";
import { HysteresisAngularFamilyInspector } from "./hysteresis/HysteresisAngularFamilyInspector";
import { HysteresisBookmarksInspector } from "./hysteresis/HysteresisBookmarksInspector";
import { HysteresisBranchDetailInspector } from "./hysteresis/HysteresisBranchDetailInspector";
import { HysteresisBranchesInspector } from "./hysteresis/HysteresisBranchesInspector";
import { HysteresisCurrentFieldInspector } from "./hysteresis/HysteresisCurrentFieldInspector";
import { HysteresisExecutionNodeInspector } from "./hysteresis/HysteresisExecutionNodeInspector";
import {
  activeHysteresisBranchSelection,
  activeHysteresisExecutionNodeSelection,
  activeHysteresisPointSelection,
  activeHysteresisSnapshotSelection,
  resolveHysteresisInspectorView,
  type HysteresisInspectorView,
} from "./hysteresis/HysteresisInspectorUtils";
import { HysteresisLiveProgressInspector } from "./hysteresis/HysteresisLiveProgressInspector";
import { HysteresisMetricsInspector } from "./hysteresis/HysteresisMetricsInspector";
import { HysteresisOrientationInspector } from "./hysteresis/HysteresisOrientationInspector";
import { HysteresisPlanInspector } from "./hysteresis/HysteresisPlanInspector";
import { HysteresisPointBucketInspector } from "./hysteresis/HysteresisPointBucketInspector";
import { HysteresisPointDetailInspector } from "./hysteresis/HysteresisPointDetailInspector";
import { HysteresisPointsInspector } from "./hysteresis/HysteresisPointsInspector";
import { HysteresisProtocolInspector } from "./hysteresis/HysteresisProtocolInspector";
import { HysteresisSaturationInspector } from "./hysteresis/HysteresisSaturationInspector";
import { HysteresisSettlePipelineInspector } from "./hysteresis/HysteresisSettlePipelineInspector";
import { HysteresisSettleTraceInspector } from "./hysteresis/HysteresisSettleTraceInspector";
import { HysteresisSnapshotsInspector } from "./hysteresis/HysteresisSnapshotsInspector";
import { HysteresisTransitionsInspector } from "./hysteresis/HysteresisTransitionsInspector";
import { summarizeMaskFieldDriveStage } from "./maskFieldDriveStageSummary";
import { SamplingDiagnostics } from "./SamplingDiagnostics";
import { formatEngineering } from "./samplingPresentation";
import {
  hasKernelResourceRuntime,
  serializeStageEnabled,
  StageAutosaveRadixEditor,
  StageInitialStateRadixControl,
  StageLiveTelemetryPanel,
  StageSpecHost,
  StageTextureOverridesRow,
  StudyStageTelemetryBridge,
} from "./StageSharedControls";
import {
  resolveStudyWorkflowStateBefore,
  validateStudyWorkflow,
  type EffectiveStudyAutosaveOutput,
  type EffectiveStudyTableAutosave,
  type EffectiveStudyWorkflowState,
} from "./studyWorkflowState";

interface StageValidationContext {
  activeLane?: ActiveLaneCapabilitySnapshot | null;
  algorithmsAvailable?: readonly string[];
  backend: string;
  demagEnabled: boolean;
  device: string;
  mode: string;
  precision: string;
}

function stageBreadcrumbs(stageTitle: string): readonly {
  id: string;
  label: string;
  selection?: Omit<Selection, "moduleSource">;
}[] {
  return [
    {
      id: "study",
      label: "Study",
      selection: {
        kind: "study.root",
        label: "Study",
        nodeId: "model:study",
        objectId: null,
        ref: { kind: "study.root", nodeId: "model:study", type: "study" },
      },
    },
    {
      id: "stages",
      label: "Stages",
      selection: {
        kind: "study.stages",
        label: "Stages",
        nodeId: "model:study:stages",
        objectId: null,
        ref: { kind: "study.stages", nodeId: "model:study:stages", type: "study" },
      },
    },
    { id: "current", label: stageTitle },
  ];
}

function resolveStageMeta(selection: Selection, defaultPrefix: string) {
  const index =
    selection.ref?.type === "study-stage" && typeof selection.ref.stageIndex === "number"
      ? selection.ref.stageIndex
      : 0;
  const stageId =
    selection.ref?.type === "study-stage" && selection.ref.stageId
      ? selection.ref.stageId
      : `${defaultPrefix}_${index + 1}`;
  return { index, stageId };
}

function fallbackPipelineSteps(
  stageId: string,
  index: number,
  kind: string,
  label: string,
): readonly PipelineStripStep[] {
  return [{ id: stageId, index, kind, label, status: "ready" }];
}

/* ── 1. study.stage.relax — RelaxStageInspectorPanel ────────────────────── */

interface RelaxStageDraft {
  stageId: string;
  stageEnabled: boolean;
  method:
    | "projected_gradient_bb"
    | "nonlinear_cg"
    | "llg_overdamped"
    | "tangent_plane_implicit";
  torqueToleranceApm: number;
  energyToleranceJ: number;
  maxSteps: number;
  maxRelaxationTimeS: number;
  maxPhysicalTimeS: number;
  maxPseudotimeS: number;
  relaxAlpha: number;
  integrator: "" | "rk23" | "rk45" | "heun";
  timestepMode: "auto" | "fixed" | "adaptive";
  dtS: number;
  dtMinS: number;
  dtMaxS: number;
  toleranceMode: "max_error" | "advanced";
  maxVectorError: number;
  atol: number;
  rtol: number;
  safety: number;
  growthLimit: number;
  shrinkLimit: number;
  maxSpinRotation: string;
  normTolerance: string;
  demagIntervalS: number;
  fieldEverySteps: string;
  stageAutosave: StageAutosaveDraft;
  stageMagnetizationAssignments: JsonValue | undefined;
  deviceLabel: string;
}

const DEFAULT_RELAX_AUTOSAVE: StageAutosaveDraft =
  createDefaultStudyStageDraft("relax", 0).stageAutosave;
const DEFAULT_RUN_AUTOSAVE: StageAutosaveDraft =
  createDefaultStudyStageDraft("run", 0).stageAutosave;

function toRelaxStudyStageDraft(
  draft: RelaxStageDraft,
  base?: StudyStageDraft,
): StudyStageDraft {
  const seed = base ?? createDefaultStudyStageDraft("relax", 0);
  const isOverdamped = draft.method === "llg_overdamped";
  const effectiveMaxRelaxTime =
    draft.maxRelaxationTimeS > 0
      ? String(draft.maxRelaxationTimeS)
      : draft.maxPhysicalTimeS > 0
        ? String(draft.maxPhysicalTimeS)
        : "";
  const fieldEveryTrimmed = draft.fieldEverySteps.trim();
  const fieldEveryCleared =
    !isOverdamped || !fieldEveryTrimmed || Number(fieldEveryTrimmed) === 0
      ? ""
      : fieldEveryTrimmed;
  const maxSpinRotTrimmed = draft.maxSpinRotation.trim();
  const normTolTrimmed = draft.normTolerance.trim();

  return {
    ...seed,
    kind: "relax",
    stageId: draft.stageId,
    stageEnabled: serializeStageEnabled(draft.stageEnabled, base),
    algorithm: draft.method,
    torqueTolerance: String(draft.torqueToleranceApm),
    energyTolerance:
      draft.energyToleranceJ > 0 ? String(draft.energyToleranceJ) : "",
    maxSteps: String(draft.maxSteps),
    maxRelaxationTime: isOverdamped ? effectiveMaxRelaxTime : "",
    maxPhysicalTime:
      isOverdamped && draft.maxPhysicalTimeS > 0
        ? String(draft.maxPhysicalTimeS)
        : "",
    maxPseudotime:
      draft.maxPseudotimeS > 0 ? String(draft.maxPseudotimeS) : "",
    relaxAlpha: isOverdamped ? String(draft.relaxAlpha) : "",
    solver: isOverdamped ? draft.integrator : "",
    timestepConflict: false,
    timestepMode: isOverdamped ? draft.timestepMode : "auto",
    dt:
      isOverdamped &&
      (draft.timestepMode === "fixed" || draft.timestepMode === "adaptive") &&
      draft.dtS > 0
        ? String(draft.dtS)
        : "",
    dtMin:
      isOverdamped && draft.timestepMode === "adaptive" && draft.dtMinS > 0
        ? String(draft.dtMinS)
        : "",
    dtMax:
      isOverdamped && draft.timestepMode === "adaptive" && draft.dtMaxS > 0
        ? String(draft.dtMaxS)
        : "",
    toleranceMode: draft.toleranceMode,
    maxError:
      isOverdamped &&
      draft.timestepMode === "adaptive" &&
      draft.toleranceMode === "max_error"
        ? String(draft.maxVectorError)
        : "",
    atol:
      isOverdamped &&
      draft.timestepMode === "adaptive" &&
      draft.toleranceMode === "advanced"
        ? String(draft.atol)
        : "",
    rtol:
      isOverdamped &&
      draft.timestepMode === "adaptive" &&
      draft.toleranceMode === "advanced"
        ? String(draft.rtol)
        : "",
    safety: String(draft.safety),
    growthLimit: String(draft.growthLimit),
    shrinkLimit: String(draft.shrinkLimit),
    maxSpinRotation:
      isOverdamped &&
      draft.timestepMode === "adaptive" &&
      draft.toleranceMode === "advanced" &&
      maxSpinRotTrimmed &&
      Number(maxSpinRotTrimmed) !== 0
        ? maxSpinRotTrimmed
        : "",
    normTolerance:
      isOverdamped &&
      draft.timestepMode === "adaptive" &&
      draft.toleranceMode === "advanced" &&
      normTolTrimmed &&
      Number(normTolTrimmed) !== 0
        ? normTolTrimmed
        : "",
    demagInterval:
      isOverdamped && draft.demagIntervalS > 0
        ? String(draft.demagIntervalS)
        : "",
    fieldEvery: fieldEveryCleared,
    stageAutosave: draft.stageAutosave,
    stageMagnetizationAssignments: draft.stageMagnetizationAssignments,
  };
}

export function RelaxStageInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  if (kernel) {
    return <ConnectedRelaxStageInspectorPanel selection={selection} />;
  }
  return <RelaxStageInspectorPanelView selection={selection} />;
}

function ConnectedRelaxStageInspectorPanel({ selection }: InspectorPanelProps) {
  const {
    commitSelectedStageDraft,
    executeSelectedStage,
    globalDraft,
    lastAuthoringError,
    pipelineStripSteps,
    runtimeStatus,
    sceneData,
    sceneRevision,
    selectedStageDraft,
    selectedStageIndex,
  } = useKernelStudyAuthoring(selection);

  const hydratedBaseline = useMemo<RelaxStageDraft>(() => {
    const d: Partial<StudyStageDraft> =
      selectedStageDraft?.kind === "relax" ? selectedStageDraft : {};
    const stageId =
      d.stageId ||
      (selection.ref?.type === "study-stage" && selection.ref.stageId
        ? selection.ref.stageId
        : `relax_${selectedStageIndex + 1}`);
    const method: RelaxStageDraft["method"] =
      d.algorithm === "nonlinear_cg" ||
      d.algorithm === "llg_overdamped" ||
      d.algorithm === "tangent_plane_implicit"
        ? d.algorithm
        : "projected_gradient_bb";
    const integrator: RelaxStageDraft["integrator"] =
      d.solver === "rk23" || d.solver === "rk45" || d.solver === "heun"
        ? d.solver
        : "";
    return {
      stageId,
      stageEnabled: d.stageEnabled ?? true,
      method,
      torqueToleranceApm: Number(d.torqueTolerance) || 100,
      energyToleranceJ: d.energyTolerance?.trim()
        ? Number(d.energyTolerance) || 0
        : 0,
      maxSteps: Number(d.maxSteps) || 50000,
      maxRelaxationTimeS: d.maxRelaxationTime?.trim()
        ? Number(d.maxRelaxationTime) || 0
        : 0,
      maxPhysicalTimeS: d.maxPhysicalTime?.trim()
        ? Number(d.maxPhysicalTime) || 0
        : 0,
      maxPseudotimeS: d.maxPseudotime?.trim()
        ? Number(d.maxPseudotime) || 0
        : 0,
      relaxAlpha: Number(d.relaxAlpha) || 1.0,
      integrator,
      timestepMode:
        d.timestepMode === "fixed" || d.timestepMode === "adaptive"
          ? d.timestepMode
          : "auto",
      dtS: Number(d.dt) || 1e-13,
      dtMinS: Number(d.dtMin) || 1e-15,
      dtMaxS: Number(d.dtMax) || 1e-11,
      toleranceMode: d.toleranceMode === "advanced" ? "advanced" : "max_error",
      maxVectorError: Number(d.maxError) || 1e-5,
      atol: Number(d.atol) || 1e-7,
      rtol: Number(d.rtol) || 1e-5,
      safety: Number(d.safety) || 0.9,
      growthLimit: Number(d.growthLimit) || 2,
      shrinkLimit: Number(d.shrinkLimit) || 0.2,
      maxSpinRotation: d.maxSpinRotation ?? "",
      normTolerance: d.normTolerance ?? "",
      demagIntervalS: d.demagInterval?.trim()
        ? Number(d.demagInterval) || 0
        : 0,
      fieldEverySteps: d.fieldEvery ?? "",
      stageAutosave: d.stageAutosave ?? DEFAULT_RELAX_AUTOSAVE,
      stageMagnetizationAssignments: d.stageMagnetizationAssignments,
      deviceLabel: `Requested ${globalDraft.requestedDevice || "auto"}`,
    };
  }, [globalDraft.requestedDevice, selectedStageDraft, selectedStageIndex, selection.ref]);

  const validationContext = useMemo<StageValidationContext>(
    () => ({
      activeLane: runtimeStatus?.capabilities.active_lane,
      algorithmsAvailable: runtimeStatus?.capabilities.algorithms_available,
      backend: globalDraft.requestedBackend,
      demagEnabled: globalDraft.demagEnabled,
      device: globalDraft.requestedDevice,
      mode: globalDraft.requestedMode,
      precision: globalDraft.requestedPrecision,
    }),
    [
      globalDraft.demagEnabled,
      globalDraft.requestedBackend,
      globalDraft.requestedDevice,
      globalDraft.requestedMode,
      globalDraft.requestedPrecision,
      runtimeStatus?.capabilities.active_lane,
      runtimeStatus?.capabilities.algorithms_available,
    ],
  );

  return (
    <StudyStageTelemetryBridge selection={selection}>
      {(selectedStageModel) => (
        <RelaxStageInspectorPanelView
          hydratedBaseline={hydratedBaseline}
          lastAuthoringError={lastAuthoringError}
          pipelineNodeId={selectedStageDraft?.pipelineNodeId}
          pipelineStripSteps={pipelineStripSteps}
          sceneData={sceneData}
          sceneRevision={sceneRevision}
          selection={selection}
          stageModel={selectedStageModel}
          validationContext={validationContext}
          onCommitStage={(draft) =>
            commitSelectedStageDraft(
              (base) => toRelaxStudyStageDraft(draft, base),
              "relax",
            )
          }
          onRunStage={(stageId, initialChoice) =>
            executeSelectedStage(stageId, initialChoice, "relax")
          }
        />
      )}
    </StudyStageTelemetryBridge>
  );
}

function RelaxStageInspectorPanelView({
  hydratedBaseline,
  lastAuthoringError = null,
  onCommitStage,
  onRunStage,
  pipelineNodeId,
  pipelineStripSteps,
  sceneData = null,
  sceneRevision = null,
  selection,
  stageModel = null,
  validationContext,
}: InspectorPanelProps & {
  hydratedBaseline?: RelaxStageDraft;
  lastAuthoringError?: string | null;
  onCommitStage?: (draft: RelaxStageDraft) => Promise<boolean>;
  onRunStage?: (stageId: string, initialChoice?: StageInitialStateChoice) => Promise<void>;
  pipelineNodeId?: string;
  pipelineStripSteps?: readonly PipelineStripStep[];
  sceneData?: SceneResource | null;
  sceneRevision?: number | null;
  stageModel?: StudyStageModel | null;
  validationContext?: StageValidationContext;
}) {
  const kernel = useContext(KernelContext);
  const [initialChoice, setInitialChoice] = useState<StageInitialStateChoice>({
    kind: "default_for_target",
  });
  const { index, stageId: fallbackId } = resolveStageMeta(selection, "relax");
  const stageId = hydratedBaseline?.stageId ?? fallbackId;
  const titleLabel = `Relax ${index + 1}`;

  const fallbackBaseline = useMemo<RelaxStageDraft>(
    () => ({
      stageId,
      stageEnabled: true,
      method: "projected_gradient_bb",
      torqueToleranceApm: 100,
      energyToleranceJ: 0,
      maxSteps: 50000,
      maxRelaxationTimeS: 5e-9,
      maxPhysicalTimeS: 0,
      maxPseudotimeS: 0,
      relaxAlpha: 1.0,
      integrator: "",
      timestepMode: "fixed",
      dtS: 1e-13,
      dtMinS: 1e-15,
      dtMaxS: 1e-11,
      toleranceMode: "max_error",
      maxVectorError: 1e-5,
      atol: 1e-7,
      rtol: 1e-5,
      safety: 0.9,
      growthLimit: 2,
      shrinkLimit: 0.2,
      maxSpinRotation: "",
      normTolerance: "",
      demagIntervalS: 0,
      fieldEverySteps: "",
      stageAutosave: DEFAULT_RELAX_AUTOSAVE,
      stageMagnetizationAssignments: undefined,
      deviceLabel: "Auto → GPU",
    }),
    [stageId],
  );
  const baseline = hydratedBaseline ?? fallbackBaseline;

  const resolvedSteps = useMemo<readonly PipelineStripStep[]>(
    () =>
      pipelineStripSteps && pipelineStripSteps.length > 0
        ? pipelineStripSteps
        : [
            { id: stageId, index, kind: "study.stage.relax", label: "Relax", status: "ready" },
            { id: "run_next", index: index + 1, kind: "study.stage.run", label: "Run", status: "ready" },
          ],
    [index, pipelineStripSteps, stageId],
  );

  const methodDisabledReason = useCallback(
    (algorithm: string): string | undefined => {
      if (!validationContext) return undefined;
      const avail = relaxationAlgorithmAvailability(algorithm, validationContext);
      return avail.supported ? undefined : (avail.reason ?? "Unavailable in active session");
    },
    [validationContext],
  );

  const spec = useMemo<InspectorSpec<RelaxStageDraft>>(
    () => ({
      id: "study.stage.relax",
      header: {
        breadcrumbs: stageBreadcrumbs(titleLabel),
        canFitView: true,
        primaryHeaderAction: {
          label: "Run up to here",
          icon: Play,
          onRun: async (ctx) => {
            if (!inspectorValuesEqual(ctx.draft, ctx.baseline) && onCommitStage) {
              const saved = await onCommitStage(ctx.draft);
              if (saved === false) return;
            }
            if (onRunStage) {
              await onRunStage(ctx.draft.stageId, initialChoice);
            } else {
              ctx.notify("Relaxation queued", ctx.draft.stageId);
            }
          },
        },
      },
      identity: {
        domain: "study",
        icon: Play,
        title: () => titleLabel,
        kindLabel: "Relaxation stage",
        entityId: stageId,
        statePill: (d) =>
          d.stageEnabled ? { tone: "ok", label: "Ready" } : { tone: "neutral", label: "Skipped" },
      },
      facts: (d): readonly InspectorFact[] => [
        { id: "pos", label: "Position", value: `${index + 1} in pipeline` },
        {
          id: "method",
          label: "Method",
          value:
            d.method === "projected_gradient_bb"
              ? "Projected grad BB"
              : d.method === "nonlinear_cg"
                ? "Nonlinear CG"
                : d.method === "tangent_plane_implicit"
                  ? "Tangent implicit"
                  : "Damped LLG",
        },
        {
          id: "tol",
          label: "Stop |m×B|",
          value: `${(d.torqueToleranceApm * 4 * Math.PI * 1e-7 * 1e3).toFixed(3)} mT`,
        },
        { id: "dev", label: "Device", value: d.deviceLabel },
      ],
      modeTabs: [
        { id: "setup", label: "Setup" },
        { id: "telemetry", label: "Telemetry", commitModeOverride: "readOnly" },
      ],
      notices: (d): readonly InspectorNotice<RelaxStageDraft>[] => {
        const list: InspectorNotice<RelaxStageDraft>[] = [];
        if (lastAuthoringError) {
          list.push({
            id: "authoring-error",
            tone: "err",
            text: lastAuthoringError,
          });
        }
        const stageDraft = toRelaxStudyStageDraft(d);
        if (pipelineNodeId) stageDraft.pipelineNodeId = pipelineNodeId;
        const issues = validateStudyStageDraft(stageDraft, validationContext);
        for (let i = 0; i < issues.length; i += 1) {
          const issue = issues[i]!;
          list.push({
            id: `relax-validation-${i}`,
            tone: issue.severity === "error" ? "err" : "warn",
            text: issue.message,
          });
        }
        return list;
      },
      sections: [
        {
          id: "pipeline",
          title: "Pipeline",
          icon: Workflow,
          modeTabId: "setup",
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <PipelineStrip
                  currentIndex={index}
                  steps={resolvedSteps}
                  onSelectStep={(step) => {
                    if (step.selection) ctx.selectNode(step.selection);
                  }}
                />
              ),
            },
            {
              key: "stageId",
              label: "Stage ID",
              type: "text",
              mono: true,
              disabledReason: () =>
                pipelineNodeId
                  ? "Canonical pipeline stage IDs are managed by the pipeline graph."
                  : null,
              validate: (val) => (!val.trim() ? "Stage ID is required." : null),
            },
            {
              key: "stageEnabled",
              label: "Include in study",
              type: "switch",
            },
            {
              label: "State handoff",
              type: "readonly",
              format: () => "In-place equilibrium state passed to next stage",
            },
          ],
        },
        {
          id: "method-stop",
          title: "Method & Stop Criteria",
          icon: Gauge,
          modeTabId: "setup",
          defaultOpen: true,
          rows: [
            {
              key: "method",
              label: "Method",
              type: "select",
              structural: true,
              options: [
                {
                  value: "projected_gradient_bb",
                  label: "LLG Projected Gradient (BB)",
                  disabledReason: methodDisabledReason("projected_gradient_bb"),
                },
                {
                  value: "nonlinear_cg",
                  label: "Nonlinear Conjugate Gradient",
                  disabledReason: methodDisabledReason("nonlinear_cg"),
                },
                {
                  value: "llg_overdamped",
                  label: "Damped LLG Precessional-Free",
                  disabledReason: methodDisabledReason("llg_overdamped"),
                },
                {
                  value: "tangent_plane_implicit",
                  label: "Tangent-Plane Implicit (FEM CPU extended)",
                  disabledReason: methodDisabledReason("tangent_plane_implicit"),
                },
              ],
            },
            {
              key: "torqueToleranceApm",
              label: "Max torque |m × B|",
              symbol: (
                <>
                  τ<sub>tol</sub>
                </>
              ),
              type: "quantity",
              units: TORQUE_APM_UNITS_SI,
              defaultDisplayUnit: "mT",
              min: 0,
              minExclusive: true,
              scrub: "log",
            },
            {
              key: "energyToleranceJ",
              label: "Energy tolerance (0 = unset)",
              symbol: (
                <>
                  ε<sub>E</sub>
                </>
              ),
              type: "quantity",
              units: ENERGY_JOULE_UNITS_SI,
              defaultDisplayUnit: "J",
              min: 0,
              scrub: "log",
            },
            {
              key: "maxSteps",
              label: "Step limit",
              symbol: (
                <>
                  N<sub>max</sub>
                </>
              ),
              type: "number",
              integer: true,
              min: 1,
              max: 10000000,
            },
            {
              key: "maxRelaxationTimeS",
              label: "Max relaxation time (0 = unset)",
              symbol: (
                <>
                  t<sub>relax</sub>
                </>
              ),
              type: "quantity",
              units: TIME_UNITS_SI,
              defaultDisplayUnit: "ns",
              min: 0,
              showWhen: (d) => d.method === "llg_overdamped",
            },
            {
              key: "maxPhysicalTimeS",
              label: "Max physical time (0 = unset)",
              symbol: (
                <>
                  t<sub>max</sub>
                </>
              ),
              type: "quantity",
              units: TIME_UNITS_SI,
              defaultDisplayUnit: "ns",
              min: 0,
              showWhen: (d) => d.method === "llg_overdamped",
            },
            {
              key: "maxPseudotimeS",
              label: "Max pseudotime (0 = unset)",
              symbol: (
                <>
                  τ<sub>max</sub>
                </>
              ),
              type: "quantity",
              units: TIME_UNITS_SI,
              defaultDisplayUnit: "ns",
              min: 0,
            },
          ],
        },
        {
          id: "llg-integrator",
          title: "Damped LLG Integrator",
          icon: Timer,
          modeTabId: "setup",
          defaultOpen: true,
          showWhen: (d) => d.method === "llg_overdamped",
          rows: [
            {
              key: "relaxAlpha",
              label: "Relaxation damping",
              symbol: (
                <>
                  α<sub>relax</sub>
                </>
              ),
              type: "number",
              min: 0.01,
              max: 10,
              step: 0.1,
            },
            {
              key: "integrator",
              label: "Integrator",
              type: "select",
              structural: true,
              options: [
                { value: "", label: "Inherit from Study" },
                { value: "rk23", label: "RK23 Bogacki–Shampine" },
                { value: "rk45", label: "RK45 Dormand–Prince" },
                { value: "heun", label: "Heun" },
              ],
            },
            {
              key: "timestepMode",
              label: "Timestep mode",
              type: "segmented",
              structural: true,
              options: [
                { value: "auto", label: "Auto" },
                { value: "fixed", label: "Fixed" },
                { value: "adaptive", label: "Adaptive" },
              ],
            },
            {
              key: "dtS",
              label: "Timestep",
              symbol: "Δt",
              type: "quantity",
              units: TIME_UNITS_SI,
              defaultDisplayUnit: "ps",
              min: 0,
              minExclusive: true,
              scrub: "log",
              showWhen: (d) => d.timestepMode !== "auto",
            },
            {
              key: "dtMinS",
              label: "Min timestep",
              symbol: (
                <>
                  Δt<sub>min</sub>
                </>
              ),
              type: "quantity",
              units: TIME_UNITS_SI,
              defaultDisplayUnit: "fs",
              min: 0,
              minExclusive: true,
              showWhen: (d) => d.timestepMode === "adaptive",
            },
            {
              key: "dtMaxS",
              label: "Max timestep",
              symbol: (
                <>
                  Δt<sub>max</sub>
                </>
              ),
              type: "quantity",
              units: TIME_UNITS_SI,
              defaultDisplayUnit: "ps",
              min: 0,
              minExclusive: true,
              showWhen: (d) => d.timestepMode === "adaptive",
            },
            {
              key: "toleranceMode",
              label: "Tolerance mode",
              type: "segmented",
              structural: true,
              showWhen: (d) => d.timestepMode === "adaptive",
              options: [
                { value: "max_error", label: "Max vector error" },
                { value: "advanced", label: "Advanced atol/rtol" },
              ],
            },
            {
              key: "maxVectorError",
              label: "Maximum embedded vector error",
              type: "number",
              min: 1e-12,
              max: 1e-1,
              scrub: "log",
              showWhen: (d) =>
                d.timestepMode === "adaptive" && d.toleranceMode === "max_error",
            },
            {
              key: "atol",
              label: "Absolute tolerance (atol)",
              type: "number",
              min: 1e-15,
              max: 1e-2,
              scrub: "log",
              showWhen: (d) =>
                d.timestepMode === "adaptive" && d.toleranceMode === "advanced",
            },
            {
              key: "rtol",
              label: "Relative tolerance (rtol)",
              type: "number",
              min: 1e-15,
              max: 1e-2,
              scrub: "log",
              showWhen: (d) =>
                d.timestepMode === "adaptive" && d.toleranceMode === "advanced",
            },
            {
              key: "safety",
              label: "Safety factor",
              type: "number",
              min: 0.1,
              max: 1,
              step: 0.05,
              showWhen: (d) =>
                d.timestepMode === "adaptive" && d.toleranceMode === "advanced",
            },
            {
              key: "growthLimit",
              label: "Growth limit",
              type: "number",
              min: 1,
              max: 20,
              showWhen: (d) =>
                d.timestepMode === "adaptive" && d.toleranceMode === "advanced",
            },
            {
              key: "shrinkLimit",
              label: "Shrink limit",
              type: "number",
              min: 0.01,
              max: 1,
              step: 0.05,
              showWhen: (d) =>
                d.timestepMode === "adaptive" && d.toleranceMode === "advanced",
            },
            {
              key: "maxSpinRotation",
              label: "Max spin rotation (rad, optional)",
              type: "text",
              mono: true,
              placeholder: "Blank to omit",
              showWhen: (d) =>
                d.timestepMode === "adaptive" && d.toleranceMode === "advanced",
            },
            {
              key: "normTolerance",
              label: "Norm tolerance (optional)",
              type: "text",
              mono: true,
              placeholder: "Blank to omit",
              showWhen: (d) =>
                d.timestepMode === "adaptive" && d.toleranceMode === "advanced",
            },
            {
              key: "demagIntervalS",
              label: "Demag update interval (0 = every step)",
              type: "quantity",
              units: TIME_UNITS_SI,
              defaultDisplayUnit: "ps",
              min: 0,
            },
            ...(!pipelineNodeId
              ? [
                  {
                    key: "fieldEverySteps" as const,
                    label: "Push field every N steps",
                    type: "text" as const,
                    mono: true,
                    placeholder: "Blank to omit",
                  },
                ]
              : []),
          ],
        },
        {
          id: "stage-autosave",
          title: "Stage Autosave",
          icon: Database,
          modeTabId: "setup",
          defaultOpen: false,
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <StageAutosaveRadixEditor
                  draft={ctx.draft.stageAutosave}
                  owner="relax"
                  onChange={(stageAutosave) =>
                    ctx.setField("stageAutosave", stageAutosave)
                  }
                />
              ),
            },
          ],
        },
        {
          id: "initial-state",
          title: "Initial State & Overrides",
          icon: Compass,
          modeTabId: "setup",
          defaultOpen: false,
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <StageInitialStateRadixControl
                  choice={initialChoice}
                  hasAuthoredReset={Boolean(
                    readStageTextureAssignments(
                      ctx.draft.stageMagnetizationAssignments,
                    )?.length,
                  )}
                  onPreviewResult={
                    kernel?.savedResultsPlayback
                      ? (result) =>
                          kernel.savedResultsPlayback?.openStudyResult(result)
                      : undefined
                  }
                  sceneRevision={sceneRevision}
                  stageId={ctx.draft.stageId}
                  onChange={setInitialChoice}
                />
              ),
            },
            ...(sceneData
              ? [
                  {
                    type: "custom" as const,
                    wide: true,
                    render: (ctx: {
                      draft: RelaxStageDraft;
                      setField: <K extends keyof RelaxStageDraft>(
                        k: K,
                        v: RelaxStageDraft[K],
                      ) => void;
                    }) => (
                      <StageTextureOverridesRow
                        scene={sceneData}
                        value={ctx.draft.stageMagnetizationAssignments}
                        onChange={(next) =>
                          ctx.setField("stageMagnetizationAssignments", next)
                        }
                      />
                    ),
                  },
                ]
              : []),
          ],
        },
        {
          id: "telemetry-convergence",
          title: "Convergence & Telemetry",
          icon: Activity,
          modeTabId: "telemetry",
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              wide: true,
              render: () => (
                <StageLiveTelemetryPanel
                  emptyDescription="Run this relaxation stage to record max torque |m × B| and energy convergence telemetry."
                  stageModel={stageModel}
                />
              ),
            },
          ],
        },
      ],
      commitBar: {
        mode: "staged",
        onApply: async (draft) => {
          if (onCommitStage) {
            return onCommitStage(draft);
          }
          return true;
        },
      },
    }),
    [
      index,
      initialChoice,
      kernel,
      lastAuthoringError,
      methodDisabledReason,
      onCommitStage,
      onRunStage,
      pipelineNodeId,
      resolvedSteps,
      sceneData,
      sceneRevision,
      stageId,
      stageModel,
      titleLabel,
      validationContext,
    ],
  );

  return <StageSpecHost baseline={baseline} selection={selection} spec={spec} />;
}

/* ── 2. study.stage.run — RunStageInspectorPanel ────────────────────────── */

interface RunStageDraft {
  stageId: string;
  stageEnabled: boolean;
  untilSeconds: number;
  legacyRunFixedTimestep: string;
  stageAutosave: StageAutosaveDraft;
  stageMagnetizationAssignments: JsonValue | undefined;
}

interface RunWorkflowDisplayInfo {
  activeDriveSummary: string;
  activeFftSummary: string;
  activeOutputsSummary: string;
  effectiveSampling: EffectiveStudyAutosaveOutput | EffectiveStudyTableAutosave | null;
  fieldEveryS: number | null;
  sincCutoffHz: number | null;
  solverDtLabel: string;
  tableColumnCount: number;
  tablePeriodS: number | null;
  tableQuantitiesSummary: string;
  tableSourceStageId: string | null;
  workflowWarnings: readonly string[];
}

export function RunStageInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  if (kernel) {
    return <ConnectedRunStageInspectorPanel selection={selection} />;
  }
  return <RunStageInspectorPanelView selection={selection} />;
}

function ConnectedRunStageInspectorPanel({ selection }: InspectorPanelProps) {
  const {
    commitSelectedStageDraft,
    executeSelectedStage,
    globalDraft,
    lastAuthoringError,
    pipelineStripSteps,
    runtimeStatus,
    sceneData,
    sceneRevision,
    selectedStageDraft,
    selectedStageIndex,
    stageDrafts,
  } = useKernelStudyAuthoring(selection);

  const hydratedBaseline = useMemo<RunStageDraft>(() => {
    const d: Partial<StudyStageDraft> =
      selectedStageDraft?.kind === "run" ? selectedStageDraft : {};
    const stageId =
      d.stageId ||
      (selection.ref?.type === "study-stage" && selection.ref.stageId
        ? selection.ref.stageId
        : `run_${selectedStageIndex + 1}`);
    return {
      stageId,
      stageEnabled: d.stageEnabled ?? true,
      untilSeconds: Number(d.untilSeconds) || 1e-9,
      legacyRunFixedTimestep: d.legacyRunFixedTimestep ?? "",
      stageAutosave: d.stageAutosave ?? DEFAULT_RUN_AUTOSAVE,
      stageMagnetizationAssignments: d.stageMagnetizationAssignments,
    };
  }, [selectedStageDraft, selectedStageIndex, selection.ref]);

  const workflowInfo = useMemo<RunWorkflowDisplayInfo>(() => {
    const wf: EffectiveStudyWorkflowState = resolveStudyWorkflowStateBefore(
      stageDrafts,
      selectedStageIndex,
    );
    const stageId = hydratedBaseline.stageId;
    const precedingDrives = stageDrafts
      .slice(0, Math.max(0, selectedStageIndex))
      .filter(
        (c) =>
          c.kind === "add_field_drive" &&
          c.fieldDrive.enabled &&
          (c.fieldDrive.activation.kind === "all_time_evolution" ||
            c.fieldDrive.activation.stage_ids.includes(stageId)),
      );
    const firstSinc = precedingDrives.find(
      (c) => c.fieldDrive.waveform.kind === "sinc_pulse",
    );
    const sincCutoffHz =
      firstSinc?.fieldDrive.waveform.kind === "sinc_pulse"
        ? firstSinc.fieldDrive.waveform.cutoff_hz
        : null;
    const solverDtS = regionalFieldDriveSamplingContext(sceneData, null).solverDtS;
    const effectiveSampling =
      wf.fftResponse?.analysis === "unsupported"
        ? null
        : wf.fftResponse?.analysis === "finite_k"
          ? (wf.outputs.find(
              (o) => o.quantity === "m" && o.outputKind === "field",
            ) ?? null)
          : wf.tableAutosave;
    const wfIssues = validateStudyWorkflow(stageDrafts)
      .filter((issue) => issue.index === selectedStageIndex)
      .map((issue) => issue.message);

    return {
      activeDriveSummary:
        precedingDrives.length > 0
          ? precedingDrives
              .map((c) => c.fieldDrive.name || c.stageId)
              .join(", ")
          : "No active preceding drive",
      activeFftSummary: wf.fftResponse
        ? wf.fftResponse.readOnly
          ? `Read-only imported ${wf.fftResponse.analysis} (${wf.fftResponse.sourceStageId})`
          : `ON: ${wf.fftResponse.analysis}, ${wf.fftResponse.responseComponent}, ${wf.fftResponse.window} (${wf.fftResponse.sourceStageId})`
        : "OFF",
      activeOutputsSummary:
        wf.outputs.length > 0
          ? wf.outputs
              .map(
                (output) =>
                  `${output.quantity} ${
                    output.everySeconds
                      ? `every ${formatEngineering(output.everySeconds, "s")}`
                      : "(auto cadence)"
                  } (${output.sourceStageId})`,
              )
              .join("; ")
          : "None — scalar table only unless Stage Autosave is enabled",
      effectiveSampling,
      fieldEveryS: wf.outputs[0]?.everySeconds ?? null,
      sincCutoffHz,
      solverDtLabel: solverDtS
        ? `${formatEngineering(solverDtS, "s")} — configured in Study › Execution`
        : "Configured globally in Study › Execution",
      tableColumnCount: (wf.tableAutosave?.quantities.length ?? 4) + 2,
      tablePeriodS: wf.tableAutosave?.samplePeriodS ?? null,
      tableQuantitiesSummary: wf.tableAutosave?.quantities.join(", ") || "None",
      tableSourceStageId: wf.tableAutosave?.sourceStageId ?? null,
      workflowWarnings: wfIssues,
    };
  }, [hydratedBaseline.stageId, sceneData, selectedStageIndex, stageDrafts]);

  const validationContext = useMemo<StageValidationContext>(
    () => ({
      activeLane: runtimeStatus?.capabilities.active_lane,
      algorithmsAvailable: runtimeStatus?.capabilities.algorithms_available,
      backend: globalDraft.requestedBackend,
      demagEnabled: globalDraft.demagEnabled,
      device: globalDraft.requestedDevice,
      mode: globalDraft.requestedMode,
      precision: globalDraft.requestedPrecision,
    }),
    [
      globalDraft.demagEnabled,
      globalDraft.requestedBackend,
      globalDraft.requestedDevice,
      globalDraft.requestedMode,
      globalDraft.requestedPrecision,
      runtimeStatus?.capabilities.active_lane,
      runtimeStatus?.capabilities.algorithms_available,
    ],
  );

  return (
    <StudyStageTelemetryBridge selection={selection}>
      {(selectedStageModel) => (
        <RunStageInspectorPanelView
          hydratedBaseline={hydratedBaseline}
          lastAuthoringError={lastAuthoringError}
          pipelineNodeId={selectedStageDraft?.pipelineNodeId}
          pipelineStripSteps={pipelineStripSteps}
          sceneData={sceneData}
          sceneRevision={sceneRevision}
          selection={selection}
          stageModel={selectedStageModel}
          validationContext={validationContext}
          workflowInfo={workflowInfo}
          onCommitStage={(draft) =>
            commitSelectedStageDraft(
              (base) => ({
                ...base,
                kind: "run",
                stageId: draft.stageId,
                stageEnabled: serializeStageEnabled(draft.stageEnabled, base),
                untilSeconds: String(draft.untilSeconds),
                legacyRunFixedTimestep: draft.legacyRunFixedTimestep,
                stageAutosave: draft.stageAutosave,
                stageMagnetizationAssignments: draft.stageMagnetizationAssignments,
              }),
              "run",
            )
          }
          onRunStage={(stageId, initialChoice) =>
            executeSelectedStage(stageId, initialChoice, "run")
          }
        />
      )}
    </StudyStageTelemetryBridge>
  );
}

function RunStageInspectorPanelView({
  hydratedBaseline,
  lastAuthoringError = null,
  onCommitStage,
  onRunStage,
  pipelineNodeId,
  pipelineStripSteps,
  sceneData = null,
  sceneRevision = null,
  selection,
  stageModel = null,
  validationContext,
  workflowInfo,
}: InspectorPanelProps & {
  hydratedBaseline?: RunStageDraft;
  lastAuthoringError?: string | null;
  onCommitStage?: (draft: RunStageDraft) => Promise<boolean>;
  onRunStage?: (stageId: string, initialChoice?: StageInitialStateChoice) => Promise<void>;
  pipelineNodeId?: string;
  pipelineStripSteps?: readonly PipelineStripStep[];
  sceneData?: SceneResource | null;
  sceneRevision?: number | null;
  stageModel?: StudyStageModel | null;
  validationContext?: StageValidationContext;
  workflowInfo?: RunWorkflowDisplayInfo;
}) {
  const kernel = useContext(KernelContext);
  const [initialChoice, setInitialChoice] = useState<StageInitialStateChoice>({
    kind: "default_for_target",
  });
  const { index, stageId: fallbackId } = resolveStageMeta(selection, "run");
  const stageId = hydratedBaseline?.stageId ?? fallbackId;
  const titleLabel = `Run ${index + 1}`;

  const fallbackBaseline = useMemo<RunStageDraft>(
    () => ({
      stageId,
      stageEnabled: true,
      untilSeconds: 10e-9,
      legacyRunFixedTimestep: "",
      stageAutosave: DEFAULT_RUN_AUTOSAVE,
      stageMagnetizationAssignments: undefined,
    }),
    [stageId],
  );
  const baseline = hydratedBaseline ?? fallbackBaseline;

  const fallbackWorkflowInfo = useMemo<RunWorkflowDisplayInfo>(
    () => ({
      activeDriveSummary: "No active preceding drive",
      activeFftSummary: "OFF",
      activeOutputsSummary: "None — scalar table only unless Stage Autosave is enabled",
      effectiveSampling: {
        autoSampling: null,
        quantities: ["t", "step", "mx", "my", "mz"],
        samplePeriodS: 500e-15,
        samplingMode: "explicit",
        sourceDriveIds: [],
        sourceStageId: "tbl_clock",
      },
      fieldEveryS: null,
      sincCutoffHz: null,
      solverDtLabel: "Configured globally in Study › Execution",
      tableColumnCount: 6,
      tablePeriodS: 500e-15,
      tableQuantitiesSummary: "t, step, mx, my, mz",
      tableSourceStageId: "tbl_clock",
      workflowWarnings: [],
    }),
    [],
  );
  const resolvedWorkflow = workflowInfo ?? fallbackWorkflowInfo;

  const resolvedSteps = useMemo<readonly PipelineStripStep[]>(
    () =>
      pipelineStripSteps && pipelineStripSteps.length > 0
        ? pipelineStripSteps
        : [
            { id: "relax_1", index: 0, kind: "study.stage.relax", label: "Relax", status: "completed" },
            { id: stageId, index, kind: "study.stage.run", label: "Run", status: "ready" },
          ],
    [index, pipelineStripSteps, stageId],
  );

  const spec = useMemo<InspectorSpec<RunStageDraft>>(
    () => ({
      id: "study.stage.run",
      header: {
        breadcrumbs: stageBreadcrumbs(titleLabel),
        canFitView: true,
        primaryHeaderAction: {
          label: "Run up to here",
          icon: Play,
          onRun: async (ctx) => {
            if (!inspectorValuesEqual(ctx.draft, ctx.baseline) && onCommitStage) {
              const saved = await onCommitStage(ctx.draft);
              if (saved === false) return;
            }
            if (onRunStage) {
              await onRunStage(ctx.draft.stageId, initialChoice);
            } else {
              ctx.notify("Time evolution run queued", ctx.draft.stageId);
            }
          },
        },
      },
      identity: {
        domain: "study",
        icon: Play,
        title: () => titleLabel,
        kindLabel: "Time evolution stage",
        entityId: stageId,
        statePill: (d) =>
          !pipelineNodeId && d.legacyRunFixedTimestep.trim()
            ? { tone: "err", label: "Legacy fix_dt" }
            : d.stageEnabled
              ? { tone: "ok", label: "Ready" }
              : { tone: "neutral", label: "Skipped" },
      },
      facts: (d): readonly InspectorFact[] => {
        const metrics = computeSamplingPlanMetrics({
          durationS: d.untilSeconds,
          tablePeriodS: resolvedWorkflow.tablePeriodS,
          tableColumnCount: resolvedWorkflow.tableColumnCount,
          fieldEveryS: resolvedWorkflow.fieldEveryS,
        });
        return [
          { id: "dur", label: "Duration", value: formatTimeCompact(d.untilSeconds) },
          { id: "solver", label: "Solver", value: "Study global" },
          {
            id: "nyq",
            label: "Nyquist f_Nyq",
            value: metrics.nyquistHz ? formatFrequencyCompact(metrics.nyquistHz) : null,
          },
          {
            id: "zarr",
            label: "Est. Zarr",
            value: formatBytesBinary(metrics.totalZarrBytes),
          },
        ];
      },
      modeTabs: [
        { id: "setup", label: "Setup" },
        { id: "telemetry", label: "Telemetry", commitModeOverride: "readOnly" },
      ],
      notices: (d): readonly InspectorNotice<RunStageDraft>[] => {
        const list: InspectorNotice<RunStageDraft>[] = [];
        if (lastAuthoringError) {
          list.push({
            id: "authoring-error",
            tone: "err",
            text: lastAuthoringError,
          });
        }
        if (!pipelineNodeId && d.legacyRunFixedTimestep.trim()) {
          list.push({
            id: "legacy-fix-dt",
            tone: "err",
            text: `Legacy Run-local fixed_timestep (${d.legacyRunFixedTimestep} s) must be moved to the global Study Execution solver settings before saving.`,
            quickFix: {
              label: "Clear legacy fix_dt",
              onApply: (ctx) => ctx.setField("legacyRunFixedTimestep", ""),
            },
          });
        }
        const metrics = computeSamplingPlanMetrics({
          durationS: d.untilSeconds,
          tablePeriodS: resolvedWorkflow.tablePeriodS,
          tableColumnCount: resolvedWorkflow.tableColumnCount,
          fieldEveryS: resolvedWorkflow.fieldEveryS,
        });
        if (
          metrics.nyquistHz !== null &&
          resolvedWorkflow.sincCutoffHz !== null &&
          resolvedWorkflow.sincCutoffHz > metrics.nyquistHz
        ) {
          list.push({
            id: "aliasing-risk",
            tone: "warn",
            text: `Aliasing risk: sinc cutoff ${formatFrequencyCompact(resolvedWorkflow.sincCutoffHz)} exceeds Nyquist frequency ${formatFrequencyCompact(metrics.nyquistHz)}.`,
          });
        }
        if (metrics.totalZarrBytes > 4 * 1024 ** 3) {
          list.push({
            id: "zarr-budget",
            tone: "warn",
            text: `Estimated Zarr output (${formatBytesBinary(metrics.totalZarrBytes)}) exceeds 4 GiB.`,
          });
        }
        for (let i = 0; i < resolvedWorkflow.workflowWarnings.length; i += 1) {
          const msg = resolvedWorkflow.workflowWarnings[i]!;
          if (!list.some((existing) => existing.text === msg)) {
            list.push({
              id: `workflow-issue-${i}`,
              tone: "warn",
              text: msg,
            });
          }
        }
        const stageDraft: StudyStageDraft = {
          ...createDefaultStudyStageDraft("run", index),
          stageId: d.stageId,
          stageEnabled: d.stageEnabled,
          untilSeconds: String(d.untilSeconds),
          legacyRunFixedTimestep: d.legacyRunFixedTimestep,
          stageAutosave: d.stageAutosave,
          stageMagnetizationAssignments: d.stageMagnetizationAssignments,
          ...(pipelineNodeId ? { pipelineNodeId } : {}),
        };
        const issues = validateStudyStageDraft(stageDraft, validationContext);
        for (let i = 0; i < issues.length; i += 1) {
          const issue = issues[i]!;
          if (
            issue.message.includes("fixed_timestep") &&
            list.some((existing) => existing.id === "legacy-fix-dt")
          ) {
            continue;
          }
          if (!list.some((existing) => existing.text === issue.message)) {
            list.push({
              id: `run-validation-${i}`,
              tone: issue.severity === "error" ? "err" : "warn",
              text: issue.message,
            });
          }
        }
        return list;
      },
      sections: [
        {
          id: "pipeline",
          title: "Pipeline",
          icon: Workflow,
          modeTabId: "setup",
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <PipelineStrip
                  currentIndex={index}
                  steps={resolvedSteps}
                  onSelectStep={(step) => {
                    if (step.selection) ctx.selectNode(step.selection);
                  }}
                />
              ),
            },
            {
              key: "stageId",
              label: "Stage ID",
              type: "text",
              mono: true,
              disabledReason: () =>
                pipelineNodeId
                  ? "Canonical pipeline stage IDs are managed by the pipeline graph."
                  : null,
              validate: (val) => (!val.trim() ? "Stage ID is required." : null),
            },
            {
              key: "stageEnabled",
              label: "Include in study",
              type: "switch",
            },
          ],
        },
        {
          id: "time-integrator",
          title: "Time & Integrator",
          icon: Timer,
          modeTabId: "setup",
          defaultOpen: true,
          rows: [
            {
              key: "untilSeconds",
              label: "Duration",
              symbol: (
                <>
                  t<sub>end</sub>
                </>
              ),
              type: "quantity",
              units: TIME_UNITS_SI,
              defaultDisplayUnit: "ns",
              min: 0,
              minExclusive: true,
              scrub: "log",
            },
            {
              label: "Solver & timestep",
              type: "readonly",
              format: () => resolvedWorkflow.solverDtLabel,
            },
            {
              type: "custom",
              label: "Legacy fixed_timestep",
              wide: true,
              showWhen: (d) =>
                !pipelineNodeId && Boolean(d.legacyRunFixedTimestep.trim()),
              render: (ctx) => (
                <div className="flex items-center justify-between gap-2 rounded border border-fm-border-subtle p-2 text-xs">
                  <span className="font-mono">
                    {`fixed_timestep = ${ctx.draft.legacyRunFixedTimestep} s`}
                  </span>
                  <Button
                    size="sm"
                    type="button"
                    variant="secondary"
                    onClick={() => ctx.setField("legacyRunFixedTimestep", "")}
                  >
                    Clear legacy fix_dt
                  </Button>
                </div>
              ),
            },
          ],
          footer: (ctx) => (
            <Button
              size="sm"
              type="button"
              variant="secondary"
              onClick={() =>
                ctx.selectNode({
                  kind: "study.execution",
                  label: "Execution",
                  nodeId: "model:study:execution",
                  objectId: null,
                  ref: {
                    kind: "study.execution",
                    nodeId: "model:study:execution",
                    type: "study",
                  },
                })
              }
            >
              Configure in Study Execution
            </Button>
          ),
        },
        {
          id: "sampling-plan",
          title: "Field & Table Sampling Plan",
          icon: FileOutput,
          modeTabId: "setup",
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <div className="grid gap-2">
                  <SamplingPlanCard
                    durationS={ctx.draft.untilSeconds}
                    fieldEveryS={resolvedWorkflow.fieldEveryS}
                    sincCutoffHz={resolvedWorkflow.sincCutoffHz}
                    tableColumnCount={resolvedWorkflow.tableColumnCount}
                    tablePeriodS={resolvedWorkflow.tablePeriodS}
                    tableSourceStageId={resolvedWorkflow.tableSourceStageId}
                  />
                  <SamplingDiagnostics
                    durationS={ctx.draft.untilSeconds}
                    sampling={resolvedWorkflow.effectiveSampling}
                  />
                </div>
              ),
            },
          ],
        },
        {
          id: "stage-autosave",
          title: "Stage Autosave",
          icon: Database,
          modeTabId: "setup",
          defaultOpen: false,
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <StageAutosaveRadixEditor
                  draft={ctx.draft.stageAutosave}
                  owner="run"
                  onChange={(stageAutosave) =>
                    ctx.setField("stageAutosave", stageAutosave)
                  }
                />
              ),
            },
          ],
        },
        {
          id: "active-drives",
          title: "Active Drives, FFT & Initial State",
          icon: Zap,
          modeTabId: "setup",
          defaultOpen: false,
          rows: [
            {
              label: "Active field drives",
              type: "readonly",
              format: () => resolvedWorkflow.activeDriveSummary,
            },
            {
              label: "Table quantities",
              type: "readonly",
              mono: true,
              format: () => resolvedWorkflow.tableQuantitiesSummary,
            },
            {
              label: "Autosave outputs",
              type: "readonly",
              format: () => resolvedWorkflow.activeOutputsSummary,
            },
            {
              label: "FFT response state",
              type: "readonly",
              format: () => resolvedWorkflow.activeFftSummary,
            },
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <StageInitialStateRadixControl
                  choice={initialChoice}
                  hasAuthoredReset={Boolean(
                    readStageTextureAssignments(
                      ctx.draft.stageMagnetizationAssignments,
                    )?.length,
                  )}
                  onPreviewResult={
                    kernel?.savedResultsPlayback
                      ? (result) =>
                          kernel.savedResultsPlayback?.openStudyResult(result)
                      : undefined
                  }
                  sceneRevision={sceneRevision}
                  stageId={ctx.draft.stageId}
                  onChange={setInitialChoice}
                />
              ),
            },
            ...(sceneData
              ? [
                  {
                    type: "custom" as const,
                    wide: true,
                    render: (ctx: {
                      draft: RunStageDraft;
                      setField: <K extends keyof RunStageDraft>(
                        k: K,
                        v: RunStageDraft[K],
                      ) => void;
                    }) => (
                      <StageTextureOverridesRow
                        scene={sceneData}
                        value={ctx.draft.stageMagnetizationAssignments}
                        onChange={(next) =>
                          ctx.setField("stageMagnetizationAssignments", next)
                        }
                      />
                    ),
                  },
                ]
              : []),
          ],
        },
        {
          id: "live-telemetry",
          title: "Live Progress & Trajectories",
          icon: Activity,
          modeTabId: "telemetry",
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              wide: true,
              render: () => (
                <StageLiveTelemetryPanel
                  emptyDescription="Start the study or run up to this stage to stream ⟨m_x⟩, ⟨m_y⟩, ⟨m_z⟩ trajectories."
                  stageModel={stageModel}
                />
              ),
            },
          ],
        },
      ],
      commitBar: {
        mode: "staged",
        onApply: async (draft) => {
          if (onCommitStage) {
            return onCommitStage(draft);
          }
          return true;
        },
      },
    }),
    [
      index,
      initialChoice,
      kernel,
      lastAuthoringError,
      onCommitStage,
      onRunStage,
      pipelineNodeId,
      resolvedSteps,
      resolvedWorkflow,
      sceneData,
      sceneRevision,
      stageId,
      stageModel,
      titleLabel,
      validationContext,
    ],
  );

  return <StageSpecHost baseline={baseline} selection={selection} spec={spec} />;
}

/* ── 3. SincPulseChart + study.stage.add_field_drive ────────────────────── */

export function SincPulseChart({
  amplitudeTesla,
  cutoffHz,
  durationS = null,
  nyquistHz,
  samplePeriodS = null,
  solverDtS = null,
  t0Seconds,
  waveformAmplitude = 1,
}: {
  amplitudeTesla: number;
  cutoffHz: number;
  durationS?: number | null;
  nyquistHz?: number;
  samplePeriodS?: number | null;
  solverDtS?: number | null;
  t0Seconds: number;
  waveformAmplitude?: number;
}) {
  const effectiveSamplePeriodS =
    samplePeriodS ??
    (typeof nyquistHz === "number" && Number.isFinite(nyquistHz) && nyquistHz > 0
      ? 1 / (2 * nyquistHz)
      : null);

  const previewModel = useMemo(
    () =>
      buildSincPulsePreview({
        cutoffHz,
        t0S: t0Seconds,
        waveformAmplitude,
        fieldAmplitudeT: amplitudeTesla,
        samplePeriodS: effectiveSamplePeriodS,
        durationS,
      }),
    [
      amplitudeTesla,
      cutoffHz,
      durationS,
      effectiveSamplePeriodS,
      t0Seconds,
      waveformAmplitude,
    ],
  );

  const optionBuilder = useCallback(
    (palette: ResolvedChartThemePalette): EChartsOption => {
      const timeSeries: [number, number][] =
        previewModel.waveform.length > 0
          ? previewModel.waveform.map((pt) => [pt.timeS * 1e12, pt.value * 1e3])
          : [
              [0, 0],
              [t0Seconds * 1e12, amplitudeTesla * waveformAmplitude * 1e3],
            ];
      const spectrumSeries: [number, number][] =
        previewModel.spectrum.length > 0
          ? previewModel.spectrum.map((pt) => [
              pt.frequencyHz / 1e9,
              pt.magnitude * 1e3,
            ])
          : [[cutoffHz / 1e9, 0]];

      return {
        animation: false,
        backgroundColor: "transparent",
        grid: [
          { left: 48, right: 14, top: 18, height: "35%" },
          { left: 48, right: 14, top: "63%", height: "28%" },
        ],
        tooltip: {
          trigger: "axis",
          backgroundColor: palette.tooltipBackground,
          borderColor: palette.borderControl,
          textStyle: { color: palette.textPrimary, fontSize: palette.fontSize },
        },
        xAxis: [
          {
            gridIndex: 0,
            type: "value",
            name: "t (ps)",
            nameLocation: "middle",
            nameGap: 16,
            axisLabel: { color: palette.textSecondary, fontSize: palette.fontSize },
            splitLine: { lineStyle: { color: palette.borderSubtle } },
          },
          {
            gridIndex: 1,
            type: "value",
            name: "f (GHz)",
            nameLocation: "middle",
            nameGap: 16,
            axisLabel: { color: palette.textSecondary, fontSize: palette.fontSize },
            splitLine: { lineStyle: { color: palette.borderSubtle } },
          },
        ],
        yAxis: [
          {
            gridIndex: 0,
            type: "value",
            name: "B(t) [mT]",
            axisLabel: { color: palette.textSecondary, fontSize: palette.fontSize },
            splitLine: { lineStyle: { color: palette.borderSubtle } },
          },
          {
            gridIndex: 1,
            type: "value",
            name: "|FFT(B)|",
            axisLabel: { color: palette.textSecondary, fontSize: palette.fontSize },
            splitLine: { lineStyle: { color: palette.borderSubtle } },
          },
        ],
        series: [
          {
            xAxisIndex: 0,
            yAxisIndex: 0,
            name: `B(t) (t0 = ${formatEngineering(t0Seconds, "s")})`,
            type: "line",
            showSymbol: false,
            data: timeSeries,
            lineStyle: { color: palette.accent, width: 2 },
          },
          {
            xAxisIndex: 1,
            yAxisIndex: 1,
            name: `|FFT(B)| (fc = ${(cutoffHz / 1e9).toFixed(2)} GHz)`,
            type: "line",
            showSymbol: false,
            data: spectrumSeries,
            lineStyle: { color: palette.series[1] ?? palette.info, width: 1.75 },
          },
        ],
      };
    },
    [amplitudeTesla, cutoffHz, previewModel.spectrum, previewModel.waveform, t0Seconds, waveformAmplitude],
  );

  return (
    <div className="grid gap-2 text-xs" role="group" aria-label="Sinc pulse and source FFT preview">
      <ScientificEChart
        ariaLabel="Sinc pulse time waveform B(t) and sampled source spectrum |FFT(B)|"
        height={240}
        optionBuilder={optionBuilder}
      />
      <div className="grid grid-cols-2 gap-1.5 rounded border border-fm-border-subtle p-2 tabular-nums">
        <div>
          <span className="text-fm-muted">Samples N: </span>
          <span>{previewModel.sampleCount}</span>
        </div>
        <div>
          <span className="text-fm-muted">Δt_sample: </span>
          <span>{formatEngineering(previewModel.samplePeriodS, "s")}</span>
        </div>
        <div>
          <span className="text-fm-muted">Nyquist: </span>
          <span>{formatEngineering(previewModel.nyquistHz, "Hz")}</span>
        </div>
        <div>
          <span className="text-fm-muted">Δf: </span>
          <span>{formatEngineering(previewModel.frequencyResolutionHz, "Hz")}</span>
        </div>
        {solverDtS ? (
          <div className="col-span-2">
            <span className="text-fm-muted">Solver Δt: </span>
            <span>{formatEngineering(solverDtS, "s")}</span>
          </div>
        ) : null}
      </div>
      <div className="text-fm-muted">{previewModel.symmetryMessage}</div>
      <div className="text-fm-muted">{previewModel.nyquistMessage}</div>
    </div>
  );
}

type SpatialSincWindowKind = "none" | "hann" | "hamming" | "blackman";

interface AddFieldDriveDraft {
  stageId: string;
  stageEnabled: boolean;
  driveEnabled: boolean;
  driveName: string;
  driveId: string;
  activationScope: "all_time_evolution" | "stage_ids";
  selectedRunStageIds: readonly string[];
  amplitudeTesla: number;
  direction: readonly [number, number, number];
  targetDomain: "global" | "object" | "region";
  targetObjectId: string;
  targetRegionId: string;
  spatialProfile: "uniform" | "sinc" | "geometry_mask";
  spatialAxis: readonly [number, number, number];
  spatialPeriodM: number;
  spatialCenterM: number;
  spatialWidthText: string;
  spatialWindow: SpatialSincWindowKind;
  maskObjectId: string;
  maskEnvelopeKind: "uniform" | "sinc";
  waveformKind: "constant" | "sinusoidal" | "pulse" | "piecewise_linear" | "sinc_pulse";
  cutoffHz: number;
  pulseCenterS: number;
  waveformAmplitude: number;
  sineFrequencyHz: number;
  sinePhaseRad: number;
  sineOffset: number;
  pulseOnS: number;
  pulseOffS: number;
  piecewisePointsText: string;
  timeOrigin: "stage_local" | "absolute";
}

function parsePiecewisePoints(raw: string): {
  points: number[][];
  error: string | null;
} {
  const lines = raw
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) {
    return {
      points: [],
      error: "Enter at least two (time_s, value) pairs on separate lines.",
    };
  }
  const points: number[][] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const pair = lines[i]!
      .split(/[ ,;]+/)
      .filter(Boolean)
      .map(Number);
    if (pair.length !== 2 || !pair.every(Number.isFinite)) {
      return {
        points: [],
        error: `Line ${i + 1} must contain two finite numbers: time_s, value.`,
      };
    }
    if (i > 0 && pair[0]! <= points[i - 1]![0]!) {
      return {
        points: [],
        error: "Piecewise-linear timestamps must be strictly increasing.",
      };
    }
    points.push([pair[0]!, pair[1]!]);
  }
  return { points, error: null };
}

function normalizeSincWindow(raw: string | undefined): SpatialSincWindowKind {
  if (raw === "hann" || raw === "hamming" || raw === "blackman") {
    return raw;
  }
  return "none";
}

function buildFieldDriveResourceFromDraft(
  draft: AddFieldDriveDraft,
  baseDrive?: RegionalFieldDriveResource,
): RegionalFieldDriveResource {
  const dirNorm = Math.hypot(
    draft.direction[0],
    draft.direction[1],
    draft.direction[2],
  );
  const unitDirection: [number, number, number] =
    Number.isFinite(dirNorm) && dirNorm > 1e-12
      ? [
          draft.direction[0] / dirNorm,
          draft.direction[1] / dirNorm,
          draft.direction[2] / dirNorm,
        ]
      : [0, 0, 0];
  const sincEnvelope: Extract<
    RegionalFieldDriveResource["spatial_profile"],
    { kind: "sinc" }
  > = {
    kind: "sinc",
    axis: [draft.spatialAxis[0], draft.spatialAxis[1], draft.spatialAxis[2]],
    period_m: draft.spatialPeriodM,
    center_m: draft.spatialCenterM,
    ...(draft.spatialWidthText.trim()
      ? { width_m: Number(draft.spatialWidthText) }
      : {}),
    window: draft.spatialWindow,
  };
  const spatial_profile: RegionalFieldDriveResource["spatial_profile"] =
    draft.spatialProfile === "sinc"
      ? sincEnvelope
      : draft.spatialProfile === "geometry_mask"
        ? {
            kind: "geometry_mask",
            object_id: draft.maskObjectId,
            envelope:
              draft.maskEnvelopeKind === "sinc"
                ? sincEnvelope
                : { kind: "uniform" },
          }
        : { kind: "uniform" };
  const target: RegionalFieldDriveResource["target"] =
    draft.targetDomain === "object"
      ? { kind: "object", object_id: draft.targetObjectId }
      : draft.targetDomain === "region"
        ? {
            kind: "region",
            object_id: draft.targetObjectId,
            region_id: draft.targetRegionId,
          }
        : { kind: "global" };
  const activation: RegionalFieldDriveResource["activation"] =
    draft.activationScope === "stage_ids"
      ? { kind: "stage_ids", stage_ids: [...draft.selectedRunStageIds] }
      : { kind: "all_time_evolution" };
  const parsedPiecewise = parsePiecewisePoints(draft.piecewisePointsText);
  const waveform: RegionalFieldDriveResource["waveform"] =
    draft.waveformKind === "constant"
      ? { kind: "constant" }
      : draft.waveformKind === "sinusoidal"
        ? {
            kind: "sinusoidal",
            frequency_hz: draft.sineFrequencyHz,
            phase_rad: draft.sinePhaseRad,
            offset: draft.sineOffset,
          }
        : draft.waveformKind === "pulse"
          ? {
              kind: "pulse",
              t_on: draft.pulseOnS,
              t_off: draft.pulseOffS,
            }
          : draft.waveformKind === "piecewise_linear"
            ? {
                kind: "piecewise_linear",
                points:
                  parsedPiecewise.points.length >= 2
                    ? parsedPiecewise.points
                    : baseDrive?.waveform.kind === "piecewise_linear"
                      ? baseDrive.waveform.points
                      : [
                          [0, 0],
                          [1e-9, 1],
                        ],
              }
            : {
                kind: "sinc_pulse",
                amplitude: draft.waveformAmplitude,
                cutoff_hz: draft.cutoffHz,
                t0: draft.pulseCenterS,
              };

  return {
    ...(baseDrive ?? createDefaultStudyStageDraft("add_field_drive", 0).fieldDrive),
    kind: "regional",
    id: draft.driveId,
    name: draft.driveName,
    enabled: draft.driveEnabled,
    amplitude_B_T: draft.amplitudeTesla,
    direction: unitDirection,
    target,
    spatial_profile,
    time_origin: draft.timeOrigin,
    activation,
    waveform,
  };
}

export function AddFieldDriveStageInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  if (kernel) {
    return <ConnectedAddFieldDriveStageInspectorPanel selection={selection} />;
  }
  return <AddFieldDriveStageInspectorPanelView selection={selection} />;
}

function ConnectedAddFieldDriveStageInspectorPanel({
  selection,
}: InspectorPanelProps) {
  const {
    commitSelectedStageDraft,
    lastAuthoringError,
    pipelineStripSteps,
    sceneData,
    selectedStageDraft,
    selectedStageIndex,
    stageDrafts,
  } = useKernelStudyAuthoring(selection);

  const availableRunIds = useMemo(() => {
    const following = stageDrafts
      .slice(selectedStageIndex + 1)
      .filter((s) => s.kind === "run")
      .map((s) => s.stageId);
    if (following.length > 0) return following;
    return stageDrafts.filter((s) => s.kind === "run").map((s) => s.stageId);
  }, [selectedStageIndex, stageDrafts]);

  const samplingContext = useMemo(() => {
    const activeDrive =
      selectedStageDraft?.kind === "add_field_drive"
        ? selectedStageDraft.fieldDrive
        : null;
    const solverDtS = regionalFieldDriveSamplingContext(
      sceneData,
      activeDrive?.activation ?? null,
    ).solverDtS;
    const subsequentRuns = stageDrafts
      .map((candidate, index) => ({ candidate, index }))
      .slice(selectedStageIndex + 1)
      .filter(({ candidate }) => candidate.kind === "run");
    const activeIds = new Set(
      activeDrive?.activation.kind === "stage_ids"
        ? activeDrive.activation.stage_ids
        : [],
    );
    const targetRun =
      activeDrive?.activation.kind === "stage_ids"
        ? (subsequentRuns.find(({ candidate }) => activeIds.has(candidate.stageId)) ??
          null)
        : (subsequentRuns[0] ?? null);
    const effectiveWorkflow = targetRun
      ? resolveStudyWorkflowStateBefore(stageDrafts, targetRun.index)
      : null;
    const rawDuration = Number(targetRun?.candidate.untilSeconds);
    return {
      durationS: Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : null,
      effectiveSampling: effectiveWorkflow?.tableAutosave ?? null,
      samplePeriodS: effectiveWorkflow?.tableAutosave?.samplePeriodS ?? null,
      solverDtS,
      targetRunStageId: targetRun?.candidate.stageId ?? null,
    };
  }, [sceneData, selectedStageDraft, selectedStageIndex, stageDrafts]);

  const hydratedBaseline = useMemo<AddFieldDriveDraft>(() => {
    const d =
      selectedStageDraft?.kind === "add_field_drive"
        ? selectedStageDraft
        : null;
    const fd = d?.fieldDrive;
    const stageId =
      d?.stageId ||
      (selection.ref?.type === "study-stage" && selection.ref.stageId
        ? selection.ref.stageId
        : `add_field_drive_${selectedStageIndex + 1}`);
    const dir =
      fd && Array.isArray(fd.direction) && fd.direction.length === 3
        ? ([
            Number(fd.direction[0]) || 0,
            Number(fd.direction[1]) || 0,
            Number(fd.direction[2]) || 0,
          ] as const)
        : ([0, 1, 0] as const);
    const sp = fd?.spatial_profile;
    const sincSp =
      sp?.kind === "sinc"
        ? sp
        : sp?.kind === "geometry_mask" && sp.envelope.kind === "sinc"
          ? sp.envelope
          : null;
    const wf = fd?.waveform;
    const firstSceneObjId = sceneData?.objects?.[0]?.id ?? "";
    return {
      stageId,
      stageEnabled: d?.stageEnabled ?? true,
      driveEnabled: fd?.enabled ?? true,
      driveName: fd?.name?.trim() ? fd.name : "Uniform transverse k0 sinc antenna",
      driveId: fd?.id?.trim() ? fd.id : stageId,
      activationScope:
        fd?.activation.kind === "stage_ids" ? "stage_ids" : "all_time_evolution",
      selectedRunStageIds:
        fd?.activation.kind === "stage_ids" ? fd.activation.stage_ids : [],
      amplitudeTesla: typeof fd?.amplitude_B_T === "number" ? fd.amplitude_B_T : 1e-3,
      direction: dir,
      targetDomain:
        fd?.target.kind === "object"
          ? "object"
          : fd?.target.kind === "region"
            ? "region"
            : "global",
      targetObjectId:
        fd?.target.kind === "object" || fd?.target.kind === "region"
          ? fd.target.object_id
          : firstSceneObjId,
      targetRegionId: fd?.target.kind === "region" ? fd.target.region_id : "",
      spatialProfile:
        sp?.kind === "sinc"
          ? "sinc"
          : sp?.kind === "geometry_mask"
            ? "geometry_mask"
            : "uniform",
      spatialAxis:
        sincSp && Array.isArray(sincSp.axis) && sincSp.axis.length === 3
          ? [sincSp.axis[0] ?? 1, sincSp.axis[1] ?? 0, sincSp.axis[2] ?? 0]
          : [1, 0, 0],
      spatialPeriodM: sincSp?.period_m ?? 100e-9,
      spatialCenterM: sincSp?.center_m ?? 0,
      spatialWidthText:
        sincSp?.width_m !== undefined && sincSp?.width_m !== null
          ? String(sincSp.width_m)
          : "",
      spatialWindow: normalizeSincWindow(sincSp?.window),
      maskObjectId: sp?.kind === "geometry_mask" ? sp.object_id : firstSceneObjId,
      maskEnvelopeKind:
        sp?.kind === "geometry_mask" && sp.envelope.kind === "sinc"
          ? "sinc"
          : "uniform",
      waveformKind: wf?.kind ?? "sinc_pulse",
      cutoffHz: wf?.kind === "sinc_pulse" ? wf.cutoff_hz : 40e9,
      pulseCenterS: wf?.kind === "sinc_pulse" ? (wf.t0 ?? 50e-12) : 50e-12,
      waveformAmplitude:
        wf?.kind === "sinc_pulse" ? (wf.amplitude ?? 1) : 1,
      sineFrequencyHz: wf?.kind === "sinusoidal" ? wf.frequency_hz : 10e9,
      sinePhaseRad: wf?.kind === "sinusoidal" ? (wf.phase_rad ?? 0) : 0,
      sineOffset: wf?.kind === "sinusoidal" ? (wf.offset ?? 0) : 0,
      pulseOnS: wf?.kind === "pulse" ? wf.t_on : 10e-12,
      pulseOffS: wf?.kind === "pulse" ? wf.t_off : 100e-12,
      piecewisePointsText:
        wf?.kind === "piecewise_linear"
          ? wf.points.map((pt) => pt.join(", ")).join("\n")
          : "0, 0\n1e-9, 1",
      timeOrigin: fd?.time_origin === "absolute" ? "absolute" : "stage_local",
    };
  }, [sceneData?.objects, selectedStageDraft, selectedStageIndex, selection.ref]);

  return (
    <AddFieldDriveStageInspectorPanelView
      followingRunIds={availableRunIds}
      hydratedBaseline={hydratedBaseline}
      lastAuthoringError={lastAuthoringError}
      pipelineNodeId={selectedStageDraft?.pipelineNodeId}
      pipelineStripSteps={pipelineStripSteps}
      samplingContext={samplingContext}
      sceneData={sceneData}
      selection={selection}
      onCommitStage={(draft) =>
        commitSelectedStageDraft(
          (base) => ({
            ...base,
            kind: "add_field_drive",
            stageId: draft.stageId,
            stageEnabled: serializeStageEnabled(draft.stageEnabled, base),
            fieldDrive: buildFieldDriveResourceFromDraft(
              draft,
              base.fieldDrive,
            ),
          }),
          "add_field_drive",
        )
      }
    />
  );
}

function AddFieldDriveStageInspectorPanelView({
  followingRunIds = [],
  hydratedBaseline,
  lastAuthoringError = null,
  onCommitStage,
  pipelineNodeId,
  pipelineStripSteps,
  samplingContext,
  sceneData = null,
  selection,
}: InspectorPanelProps & {
  followingRunIds?: readonly string[];
  hydratedBaseline?: AddFieldDriveDraft;
  lastAuthoringError?: string | null;
  onCommitStage?: (draft: AddFieldDriveDraft) => Promise<boolean>;
  pipelineNodeId?: string;
  pipelineStripSteps?: readonly PipelineStripStep[];
  samplingContext?: {
    durationS: number | null;
    effectiveSampling: EffectiveStudyTableAutosave | null;
    samplePeriodS: number | null;
    solverDtS: number | null;
    targetRunStageId: string | null;
  };
  sceneData?: SceneResource | null;
}) {
  const { index, stageId: fallbackId } = resolveStageMeta(selection, "add_field_drive");
  const stageId = hydratedBaseline?.stageId ?? fallbackId;
  const titleLabel = `Add Field Drive ${index + 1}`;
  const selectorOptions = useMemo(
    () => regionalFieldDriveSelectorOptions(sceneData),
    [sceneData],
  );

  const fallbackBaseline = useMemo<AddFieldDriveDraft>(
    () => ({
      stageId,
      stageEnabled: true,
      driveEnabled: true,
      driveName: "Uniform transverse k0 sinc antenna",
      driveId: stageId,
      activationScope: "all_time_evolution",
      selectedRunStageIds: [],
      amplitudeTesla: 1e-3,
      direction: [0, 1, 0],
      targetDomain: "global",
      targetObjectId: "",
      targetRegionId: "",
      spatialProfile: "uniform",
      spatialAxis: [1, 0, 0],
      spatialPeriodM: 100e-9,
      spatialCenterM: 0,
      spatialWidthText: "",
      spatialWindow: "none",
      maskObjectId: "",
      maskEnvelopeKind: "uniform",
      waveformKind: "sinc_pulse",
      cutoffHz: 40e9,
      pulseCenterS: 50e-12,
      waveformAmplitude: 1,
      sineFrequencyHz: 10e9,
      sinePhaseRad: 0,
      sineOffset: 0,
      pulseOnS: 10e-12,
      pulseOffS: 100e-12,
      piecewisePointsText: "0, 0\n1e-9, 1",
      timeOrigin: "stage_local",
    }),
    [stageId],
  );
  const baseline = hydratedBaseline ?? fallbackBaseline;

  const resolvedSteps = useMemo<readonly PipelineStripStep[]>(
    () =>
      pipelineStripSteps && pipelineStripSteps.length > 0
        ? pipelineStripSteps
        : fallbackPipelineSteps(
            stageId,
            index,
            "study.stage.add_field_drive",
            "Add field drive",
          ),
    [index, pipelineStripSteps, stageId],
  );

  const spec = useMemo<InspectorSpec<AddFieldDriveDraft>>(() => {
    const hasSceneObjects = sceneData !== null && selectorOptions.objects.length > 0;
    const objectOptions = selectorOptions.objects.map((o) => ({
      value: o.id,
      label: o.label,
    }));

    return {
      id: "study.stage.add_field_drive",
      header: {
        breadcrumbs: stageBreadcrumbs(titleLabel),
        canFitView: true,
      },
      identity: {
        domain: "study",
        icon: Zap,
        title: (d) => d.driveName,
        renameFieldKey: "driveName",
        kindLabel: "Regional field drive instruction",
        entityId: stageId,
        statePill: (d) =>
          d.driveEnabled
            ? { tone: "ok", label: "0 s config" }
            : { tone: "neutral", label: "Drive OFF" },
      },
      facts: (d): readonly InspectorFact[] => [
        { id: "dur", label: "Duration", value: "0 s (config)" },
        { id: "wf", label: "Waveform", value: d.waveformKind.replace(/_/g, " ") },
        { id: "amp", label: "Amplitude B₀", value: `${(d.amplitudeTesla * 1e3).toFixed(2)} mT` },
        {
          id: "fc",
          label: "Cutoff fc",
          value: d.waveformKind === "sinc_pulse" ? formatFrequencyCompact(d.cutoffHz) : null,
        },
      ],
      notices: (d) => {
        const list: InspectorNotice<AddFieldDriveDraft>[] = [];
        if (lastAuthoringError) {
          list.push({
            id: "authoring-error",
            tone: "err",
            text: lastAuthoringError,
          });
        }
        if (
          d.waveformKind === "sinc_pulse" &&
          d.pulseCenterS < 6 / Math.max(d.cutoffHz, 1)
        ) {
          list.push({
            id: "sinc-truncation",
            tone: "warn",
            text: "Pulse center t₀ is shorter than 6 / fc, truncating the leading sinc lobe at t = 0.",
            quickFix: {
              label: "Set t₀ = 8 / fc",
              onApply: (ctx) => ctx.setField("pulseCenterS", 8 / ctx.draft.cutoffHz),
            },
          });
        }
        const driveCandidate = buildFieldDriveResourceFromDraft(d);
        const driveErrors = validateFieldDriveDraft(driveCandidate);
        for (let i = 0; i < driveErrors.length; i += 1) {
          list.push({
            id: `drive-validation-${i}`,
            tone: "err",
            text: driveErrors[i]!,
          });
        }
        return list;
      },
      sections: [
        {
          id: "pipeline",
          title: "Pipeline & Activation",
          icon: Workflow,
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <PipelineStrip
                  currentIndex={index}
                  steps={resolvedSteps}
                  onSelectStep={(step) => {
                    if (step.selection) ctx.selectNode(step.selection);
                  }}
                />
              ),
            },
            {
              key: "stageId",
              label: "Stage ID",
              type: "text",
              mono: true,
              disabledReason: () =>
                pipelineNodeId
                  ? "Canonical pipeline stage IDs are managed by the pipeline graph."
                  : null,
              validate: (val) => (!val.trim() ? "Stage ID is required." : null),
            },
            {
              key: "driveEnabled",
              label: "Enable field drive",
              type: "switch",
            },
            ...(pipelineNodeId
              ? [
                  {
                    key: "stageEnabled" as const,
                    label: "Include pipeline node",
                    type: "switch" as const,
                  },
                ]
              : []),
            {
              key: "driveId",
              label: "Drive ID",
              type: "text",
              mono: true,
              validate: (val) => (!val.trim() ? "Drive ID is required." : null),
            },
            {
              key: "activationScope",
              label: "Activation scope",
              type: "segmented",
              structural: true,
              options: [
                { value: "all_time_evolution", label: "All following Runs" },
                { value: "stage_ids", label: "Selected Runs" },
              ],
            },
            {
              type: "custom",
              label: "Target Run stages",
              wide: true,
              showWhen: (d) => d.activationScope === "stage_ids",
              render: (ctx) => {
                const candidateRunIds = Array.from(
                  new Set([...followingRunIds, ...ctx.draft.selectedRunStageIds]),
                );
                return candidateRunIds.length === 0 ? (
                  <div className="text-xs text-fm-muted">
                    Add a Run stage in Study › Stages to bind specific Run stage IDs.
                  </div>
                ) : (
                  <div className="grid gap-1.5 text-xs">
                    {candidateRunIds.map((runId) => {
                      const active = ctx.draft.selectedRunStageIds.includes(runId);
                      return (
                        <div
                          className="flex items-center justify-between gap-2"
                          key={runId}
                        >
                          <span className="font-mono">{runId}</span>
                          <Switch
                            aria-label={`Activate drive in ${runId}`}
                            checked={active}
                            onCheckedChange={(checked) =>
                              ctx.setField(
                                "selectedRunStageIds",
                                checked
                                  ? [...ctx.draft.selectedRunStageIds, runId]
                                  : ctx.draft.selectedRunStageIds.filter(
                                      (id) => id !== runId,
                                    ),
                              )
                            }
                          />
                        </div>
                      );
                    })}
                  </div>
                );
              },
            },
          ],
        },
        {
          id: "spatial-target",
          title: "Spatial Target & Field Vector",
          icon: Magnet,
          defaultOpen: true,
          rows: [
            {
              key: "amplitudeTesla",
              label: "Amplitude",
              symbol: (
                <>
                  B<sub>0</sub>
                </>
              ),
              type: "quantity",
              units: FIELD_TESLA_UNITS_SI,
              defaultDisplayUnit: "mT",
              min: 0,
              scrub: "log",
            },
            {
              key: "direction",
              label: "Direction",
              symbol: (
                <>
                  ê<sub>B</sub>
                </>
              ),
              type: "vector3",
              normalizeAction: true,
            },
            {
              key: "targetDomain",
              label: "Target domain",
              type: "segmented",
              structural: true,
              options: [
                { value: "global", label: "Global" },
                { value: "object", label: "Object" },
                { value: "region", label: "Region" },
              ],
            },
            ...(hasSceneObjects
              ? [
                  {
                    key: "targetObjectId" as const,
                    label: "Target object",
                    type: "select" as const,
                    structural: true,
                    showWhen: (d: AddFieldDriveDraft) => d.targetDomain !== "global",
                    options: [
                      { value: "", label: "Select an object…" },
                      ...objectOptions,
                      ...(baseline.targetObjectId &&
                      !objectOptions.some((o) => o.value === baseline.targetObjectId)
                        ? [{ value: baseline.targetObjectId, label: baseline.targetObjectId }]
                        : []),
                    ],
                  },
                  {
                    type: "custom" as const,
                    label: "Target region",
                    showWhen: (d: AddFieldDriveDraft) => d.targetDomain === "region",
                    render: (ctx: {
                      draft: AddFieldDriveDraft;
                      setField: <K extends keyof AddFieldDriveDraft>(
                        k: K,
                        v: AddFieldDriveDraft[K],
                      ) => void;
                    }) => {
                      const regionChoices =
                        selectorOptions.regionsByObject[ctx.draft.targetObjectId] ?? [];
                      const allRegions =
                        ctx.draft.targetRegionId &&
                        !regionChoices.some((r) => r.id === ctx.draft.targetRegionId)
                          ? [
                              ...regionChoices,
                              {
                                id: ctx.draft.targetRegionId,
                                label: ctx.draft.targetRegionId,
                              },
                            ]
                          : regionChoices;
                      return (
                        <div className="grid gap-1 text-xs">
                          <div className="flex flex-wrap gap-1">
                            {allRegions.length > 0 ? (
                              allRegions.map((reg) => (
                                <Button
                                  key={reg.id}
                                  size="sm"
                                  type="button"
                                  variant={
                                    ctx.draft.targetRegionId === reg.id
                                      ? "primary"
                                      : "secondary"
                                  }
                                  onClick={() =>
                                    ctx.setField("targetRegionId", reg.id)
                                  }
                                >
                                  {reg.label}
                                </Button>
                              ))
                            ) : (
                              <span className="text-fm-muted">
                                {ctx.draft.targetObjectId
                                  ? "No regions declared on selected object."
                                  : "Select a target object first."}
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    },
                  },
                ]
              : [
                  {
                    key: "targetObjectId" as const,
                    label: "Target object",
                    type: "text" as const,
                    mono: true,
                    showWhen: (d: AddFieldDriveDraft) => d.targetDomain !== "global",
                  },
                  {
                    key: "targetRegionId" as const,
                    label: "Target region",
                    type: "text" as const,
                    mono: true,
                    showWhen: (d: AddFieldDriveDraft) => d.targetDomain === "region",
                  },
                ]),
            {
              key: "spatialProfile",
              label: "Spatial profile",
              type: "select",
              structural: true,
              options: [
                { value: "uniform", label: "Uniform" },
                { value: "sinc", label: "Spatial sinc (finite-k)" },
                { value: "geometry_mask", label: "Geometry object mask" },
              ],
            },
            ...(hasSceneObjects
              ? [
                  {
                    key: "maskObjectId" as const,
                    label: "Mask geometry object",
                    type: "select" as const,
                    showWhen: (d: AddFieldDriveDraft) =>
                      d.spatialProfile === "geometry_mask",
                    options: [
                      { value: "", label: "Select mask geometry…" },
                      ...objectOptions,
                      ...(baseline.maskObjectId &&
                      !objectOptions.some((o) => o.value === baseline.maskObjectId)
                        ? [{ value: baseline.maskObjectId, label: baseline.maskObjectId }]
                        : []),
                    ],
                  },
                ]
              : [
                  {
                    key: "maskObjectId" as const,
                    label: "Mask geometry object",
                    type: "text" as const,
                    mono: true,
                    showWhen: (d: AddFieldDriveDraft) =>
                      d.spatialProfile === "geometry_mask",
                  },
                ]),
            {
              key: "maskEnvelopeKind",
              label: "Mask spatial envelope",
              type: "segmented",
              structural: true,
              showWhen: (d) => d.spatialProfile === "geometry_mask",
              options: [
                { value: "uniform", label: "Uniform" },
                { value: "sinc", label: "Spatial sinc" },
              ],
            },
            {
              key: "spatialAxis",
              label: "Spatial sinc axis",
              type: "vector3",
              normalizeAction: true,
              showWhen: (d) =>
                d.spatialProfile === "sinc" ||
                (d.spatialProfile === "geometry_mask" &&
                  d.maskEnvelopeKind === "sinc"),
            },
            {
              key: "spatialPeriodM",
              label: "Spatial period",
              symbol: (
                <>
                  λ<sub>0</sub>
                </>
              ),
              type: "quantity",
              units: LENGTH_UNITS_SI,
              defaultDisplayUnit: "nm",
              min: 0,
              minExclusive: true,
              showWhen: (d) =>
                d.spatialProfile === "sinc" ||
                (d.spatialProfile === "geometry_mask" &&
                  d.maskEnvelopeKind === "sinc"),
            },
            {
              key: "spatialCenterM",
              label: "Spatial center",
              type: "quantity",
              units: LENGTH_UNITS_SI,
              defaultDisplayUnit: "nm",
              showWhen: (d) =>
                d.spatialProfile === "sinc" ||
                (d.spatialProfile === "geometry_mask" &&
                  d.maskEnvelopeKind === "sinc"),
            },
            {
              key: "spatialWidthText",
              label: "Spatial width (m, optional)",
              type: "text",
              mono: true,
              placeholder: "Blank for unbounded envelope",
              showWhen: (d) =>
                d.spatialProfile === "sinc" ||
                (d.spatialProfile === "geometry_mask" &&
                  d.maskEnvelopeKind === "sinc"),
              validate: (val) =>
                val.trim() && (!Number.isFinite(Number(val)) || Number(val) <= 0)
                  ? "Spatial width must be positive when set."
                  : null,
            },
            {
              key: "spatialWindow",
              label: "Spatial window",
              type: "segmented",
              showWhen: (d) =>
                d.spatialProfile === "sinc" ||
                (d.spatialProfile === "geometry_mask" &&
                  d.maskEnvelopeKind === "sinc"),
              options: [
                { value: "none", label: "None" },
                { value: "hann", label: "Hann" },
                { value: "hamming", label: "Hamming" },
                { value: "blackman", label: "Blackman" },
              ],
            },
          ],
        },
        {
          id: "waveform",
          title: "Time Waveform & Spectrum Preview",
          icon: Waves,
          defaultOpen: true,
          rows: [
            {
              key: "waveformKind",
              label: "Waveform",
              type: "select",
              structural: true,
              options: [
                { value: "constant", label: "Constant" },
                { value: "sinusoidal", label: "Sinusoidal" },
                { value: "pulse", label: "Rectangular pulse" },
                { value: "piecewise_linear", label: "Piecewise linear" },
                { value: "sinc_pulse", label: "Sinc pulse" },
              ],
            },
            {
              key: "cutoffHz",
              label: "Cutoff frequency",
              symbol: (
                <>
                  f<sub>c</sub>
                </>
              ),
              type: "quantity",
              units: FREQUENCY_UNITS_SI,
              defaultDisplayUnit: "GHz",
              min: 0,
              minExclusive: true,
              scrub: "log",
              showWhen: (d) => d.waveformKind === "sinc_pulse",
            },
            {
              key: "pulseCenterS",
              label: "Pulse center",
              symbol: (
                <>
                  t<sub>0</sub>
                </>
              ),
              type: "quantity",
              units: TIME_UNITS_SI,
              defaultDisplayUnit: "ps",
              min: 0,
              showWhen: (d) => d.waveformKind === "sinc_pulse",
            },
            {
              key: "waveformAmplitude",
              label: "Waveform scale a",
              type: "number",
              step: 0.1,
              showWhen: (d) => d.waveformKind === "sinc_pulse",
            },
            {
              key: "sineFrequencyHz",
              label: "Drive frequency",
              symbol: (
                <>
                  f<sub>0</sub>
                </>
              ),
              type: "quantity",
              units: FREQUENCY_UNITS_SI,
              defaultDisplayUnit: "GHz",
              min: 0,
              minExclusive: true,
              showWhen: (d) => d.waveformKind === "sinusoidal",
            },
            {
              key: "sinePhaseRad",
              label: "Initial phase",
              symbol: (
                <>
                  φ<sub>0</sub>
                </>
              ),
              type: "quantity",
              units: ANGLE_RAD_UNITS_SI,
              defaultDisplayUnit: "deg",
              showWhen: (d) => d.waveformKind === "sinusoidal",
            },
            {
              key: "sineOffset",
              label: "DC offset",
              type: "number",
              step: 0.01,
              showWhen: (d) => d.waveformKind === "sinusoidal",
            },
            {
              key: "pulseOnS",
              label: "Pulse on time",
              type: "quantity",
              units: TIME_UNITS_SI,
              defaultDisplayUnit: "ps",
              min: 0,
              showWhen: (d) => d.waveformKind === "pulse",
            },
            {
              key: "pulseOffS",
              label: "Pulse off time",
              type: "quantity",
              units: TIME_UNITS_SI,
              defaultDisplayUnit: "ps",
              min: 0,
              minExclusive: true,
              showWhen: (d) => d.waveformKind === "pulse",
              validate: (val, d) =>
                val <= d.pulseOnS ? "Pulse off time must exceed pulse on time." : null,
            },
            {
              key: "piecewisePointsText",
              label: "Points (time_s, value; one pair per line)",
              type: "expression",
              multiline: true,
              showWhen: (d) => d.waveformKind === "piecewise_linear",
              validate: (val) => parsePiecewisePoints(val).error,
            },
            {
              key: "timeOrigin",
              label: "Time origin",
              type: "segmented",
              showWhen: (d) => d.waveformKind !== "constant",
              options: [
                { value: "stage_local", label: "Stage local (t = 0)" },
                { value: "absolute", label: "Absolute time" },
              ],
            },
            {
              type: "custom",
              wide: true,
              showWhen: (d) => d.waveformKind === "sinc_pulse",
              render: (ctx) => (
                <div className="grid gap-2">
                  <SincPulseChart
                    amplitudeTesla={ctx.draft.amplitudeTesla}
                    cutoffHz={ctx.draft.cutoffHz}
                    durationS={samplingContext?.durationS ?? null}
                    samplePeriodS={samplingContext?.samplePeriodS ?? null}
                    solverDtS={samplingContext?.solverDtS ?? null}
                    t0Seconds={ctx.draft.pulseCenterS}
                    waveformAmplitude={ctx.draft.waveformAmplitude}
                  />
                  {samplingContext ? (
                    <SamplingDiagnostics
                      durationS={samplingContext.durationS}
                      sampling={samplingContext.effectiveSampling}
                    />
                  ) : null}
                </div>
              ),
            },
          ],
        },
      ],
      commitBar: {
        mode: "staged",
        onApply: async (draft) => {
          if (onCommitStage) {
            return onCommitStage(draft);
          }
          return true;
        },
      },
    };
  }, [
    baseline.maskObjectId,
    baseline.targetObjectId,
    followingRunIds,
    index,
    lastAuthoringError,
    onCommitStage,
    pipelineNodeId,
    resolvedSteps,
    samplingContext,
    sceneData,
    selectorOptions.objects,
    selectorOptions.regionsByObject,
    stageId,
    titleLabel,
  ]);

  return (
    <StageSpecHost
      baseline={baseline}
      selection={selection}
      spec={spec}
      deriveFieldPatch={(key, value, nextDraft) => {
        if (key === "targetObjectId") {
          const nextObj = String(value ?? "");
          const validRegions = selectorOptions.regionsByObject[nextObj] ?? [];
          if (
            nextDraft.targetRegionId &&
            !validRegions.some((r) => r.id === nextDraft.targetRegionId)
          ) {
            return { targetRegionId: validRegions[0]?.id ?? "" };
          }
        }
        return null;
      }}
    />
  );
}

/* ── 4. study.stage.mask_field_drive ────────────────────────────────────── */

interface MaskFieldDriveTermView {
  readonly label: string;
  readonly maskCall: string;
  readonly maskParameters: string | null;
  readonly maskOutputs: readonly string[];
  readonly timeCall: string;
  readonly timeParameters: string | null;
  readonly timeOutputs: readonly string[];
}

interface MaskFieldDriveDraft {
  stageId: string;
  stageEnabled: boolean;
  actionKind: "add" | "update";
  driveId: string;
  driveName: string;
  target: string;
  shape: string;
  frame: string;
  timeOrigin: string;
  termLabel: string;
  maskParameters: string;
  timeParameters: string;
  terms: readonly MaskFieldDriveTermView[];
}

function extractRawFunctionParameters(fnRecord: unknown): string | null {
  if (!fnRecord || typeof fnRecord !== "object" || Array.isArray(fnRecord)) {
    return null;
  }
  const params = (fnRecord as Record<string, unknown>).parameters;
  if (!Array.isArray(params) || params.length === 0) return null;
  const formatted = params.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const rec = entry as Record<string, unknown>;
    return [`${String(rec.name ?? "")} = ${String(rec.value ?? "")}`];
  });
  return formatted.length > 0 ? formatted.join(", ") : null;
}

function extractMaskTermParameterDetails(
  rawStage: Record<string, unknown> | undefined,
): Array<{ maskParams: string | null; timeParams: string | null }> {
  if (!rawStage) return [];
  const payload =
    rawStage.payload &&
    typeof rawStage.payload === "object" &&
    !Array.isArray(rawStage.payload)
      ? (rawStage.payload as Record<string, unknown>)
      : rawStage;
  const drive =
    payload.drive && typeof payload.drive === "object" && !Array.isArray(payload.drive)
      ? (payload.drive as Record<string, unknown>)
      : null;
  const terms = Array.isArray(drive?.terms) ? drive.terms : [];
  return terms.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { maskParams: null, timeParams: null };
    }
    const term = entry as Record<string, unknown>;
    const mask =
      term.mask && typeof term.mask === "object" && !Array.isArray(term.mask)
        ? (term.mask as Record<string, unknown>)
        : null;
    return {
      maskParams: mask?.kind === "function" ? extractRawFunctionParameters(mask.function) : null,
      timeParams: extractRawFunctionParameters(term.time),
    };
  });
}

export function MaskFieldDriveStageInspectorPanel({
  selection,
  rawStagePayload,
}: InspectorPanelProps & {
  rawStagePayload?: Record<string, unknown>;
}) {
  const kernel = useContext(KernelContext);
  if (kernel && !rawStagePayload) {
    return <ConnectedMaskFieldDriveStagePanel selection={selection} />;
  }
  return (
    <MaskFieldDriveStageInspectorPanelView
      rawStagePayload={rawStagePayload}
      selection={selection}
    />
  );
}

function ConnectedMaskFieldDriveStagePanel({ selection }: InspectorPanelProps) {
  const {
    commitStudyMetadata,
    lastAuthoringError,
    pipelineStripSteps,
    sceneData,
    selectedStageDraft,
  } = useKernelStudyAuthoring(selection);
  const pipelineNodeId = selectedStageDraft?.pipelineNodeId;

  return (
    <MaskFieldDriveStageInspectorPanelView
      lastAuthoringError={lastAuthoringError}
      pipelineNodeId={pipelineNodeId}
      pipelineStripSteps={pipelineStripSteps}
      rawStagePayload={selectedStageDraft?.rawStage}
      selection={selection}
      stageEnabledFromScene={selectedStageDraft?.stageEnabled}
      stageIdFromScene={selectedStageDraft?.stageId}
      onCommitStage={
        pipelineNodeId
          ? async (draft) => {
              const study =
                sceneData?.study && typeof sceneData.study === "object"
                  ? (sceneData.study as Record<string, unknown>)
                  : null;
              const pipeline =
                study?.study_pipeline && typeof study.study_pipeline === "object"
                  ? (study.study_pipeline as Record<string, unknown>)
                  : null;
              if (!pipeline || !Array.isArray(pipeline.nodes)) return false;
              const patchNodes = (nodes: JsonValue[]): JsonValue[] =>
                nodes.map((item) => {
                  if (!item || typeof item !== "object" || Array.isArray(item)) {
                    return item;
                  }
                  const rec = item as JsonObject;
                  if (rec.id === pipelineNodeId) {
                    return { ...rec, enabled: draft.stageEnabled };
                  }
                  if (rec.node_kind === "group" && Array.isArray(rec.children)) {
                    return { ...rec, children: patchNodes(rec.children) };
                  }
                  return rec;
                });
              return commitStudyMetadata({
                study_pipeline: {
                  ...pipeline,
                  nodes: patchNodes(pipeline.nodes as JsonValue[]),
                },
              });
            }
          : undefined
      }
    />
  );
}

function MaskFieldDriveStageInspectorPanelView({
  lastAuthoringError = null,
  onCommitStage,
  pipelineNodeId,
  pipelineStripSteps,
  rawStagePayload,
  selection,
  stageEnabledFromScene,
  stageIdFromScene,
}: InspectorPanelProps & {
  lastAuthoringError?: string | null;
  onCommitStage?: (draft: MaskFieldDriveDraft) => Promise<boolean>;
  pipelineNodeId?: string;
  pipelineStripSteps?: readonly PipelineStripStep[];
  rawStagePayload?: Record<string, unknown>;
  stageEnabledFromScene?: boolean;
  stageIdFromScene?: string;
}) {
  const { index, stageId: fallbackId } = resolveStageMeta(selection, "mask_drive");
  const stageId = stageIdFromScene ?? fallbackId;
  const summary = useMemo(
    () =>
      rawStagePayload
        ? summarizeMaskFieldDriveStage(rawStagePayload)
        : null,
    [rawStagePayload],
  );
  const termParamDetails = useMemo(
    () => extractMaskTermParameterDetails(rawStagePayload),
    [rawStagePayload],
  );

  const baseline = useMemo<MaskFieldDriveDraft>(() => {
    const mappedTerms: MaskFieldDriveTermView[] = summary
      ? summary.terms.map((t, idx) => ({
          label: t.label,
          maskCall: t.mask.call,
          maskParameters: termParamDetails[idx]?.maskParams ?? null,
          maskOutputs: t.mask.outputs,
          timeCall: t.time.call,
          timeParameters: termParamDetails[idx]?.timeParams ?? null,
          timeOutputs: t.time.outputs,
        }))
      : [
          {
            label: "term 0",
            maskCall: "not declared",
            maskParameters: null,
            maskOutputs: [],
            timeCall: "1 (static)",
            timeParameters: null,
            timeOutputs: [],
          },
        ];

    return {
      stageId,
      stageEnabled: stageEnabledFromScene ?? true,
      actionKind: summary?.action ?? "add",
      driveId: summary?.driveId ?? stageId,
      driveName: summary?.driveName ?? summary?.driveId ?? "Mask antenna drive",
      target: summary?.target ?? "not declared",
      shape: summary?.shape ?? "not declared",
      frame: summary?.frame ?? "local",
      timeOrigin: summary?.timeOrigin ?? "stage_local",
      termLabel: summary?.term ?? "the only term",
      maskParameters: summary?.maskParameters ?? "unchanged",
      timeParameters: summary?.timeParameters ?? "unchanged",
      terms: mappedTerms,
    };
  }, [stageEnabledFromScene, stageId, summary, termParamDetails]);

  const resolvedSteps = useMemo<readonly PipelineStripStep[]>(
    () =>
      pipelineStripSteps && pipelineStripSteps.length > 0
        ? pipelineStripSteps
        : fallbackPipelineSteps(
            stageId,
            index,
            "study.stage.mask_field_drive",
            summary?.kindLabel ?? "Mask field drive",
          ),
    [index, pipelineStripSteps, stageId, summary?.kindLabel],
  );

  const titleLabel =
    summary?.kindLabel ? `${summary.kindLabel} ${index + 1}` : `Mask Field Drive ${index + 1}`;
  const canTogglePipelineNode = Boolean(pipelineNodeId && onCommitStage);

  const spec = useMemo<InspectorSpec<MaskFieldDriveDraft>>(() => {
    const termSections: InspectorSectionSpec<MaskFieldDriveDraft>[] =
      baseline.actionKind === "update"
        ? [
            {
              id: "antenna-update",
              title: "Antenna Parameter Update",
              icon: Radar,
              defaultOpen: true,
              rows: [
                {
                  label: "Antenna ID",
                  type: "readonly",
                  mono: true,
                  format: (d) => d.driveId,
                },
                {
                  label: "Term",
                  type: "readonly",
                  format: (d) => d.termLabel,
                },
                {
                  label: "Mask values",
                  type: "readonly",
                  mono: true,
                  format: (d) => d.maskParameters,
                },
                {
                  label: "Time values",
                  type: "readonly",
                  mono: true,
                  format: (d) => d.timeParameters,
                },
                {
                  label: "Effect",
                  type: "readonly",
                  format: () =>
                    "Applies updated values from this stage onward; antenna definition remains unchanged",
                },
              ],
            },
          ]
        : [
            {
              id: "antenna-meta",
              title: "Mask Antenna Metadata",
              icon: Compass,
              defaultOpen: true,
              rows: [
                {
                  label: "Antenna ID",
                  type: "readonly",
                  mono: true,
                  format: (d) => d.driveId,
                },
                { label: "Target", type: "readonly", format: (d) => d.target },
                { label: "Support", type: "readonly", format: (d) => d.shape },
                { label: "Frame", type: "readonly", format: (d) => d.frame },
                { label: "Clock", type: "readonly", format: (d) => d.timeOrigin },
                {
                  label: "Effect",
                  type: "readonly",
                  format: () => "Active from this stage until a Remove stage",
                },
              ],
            },
            ...baseline.terms.map(
              (term, termIdx): InspectorSectionSpec<MaskFieldDriveDraft> => ({
                id: `mask-term-${termIdx}`,
                title: `Term ${term.label} (Mask × Time)`,
                icon: Radar,
                defaultOpen: true,
                rows: [
                  {
                    label: "Mask",
                    type: "readonly",
                    mono: true,
                    format: () => term.maskCall,
                  },
                  ...(term.maskParameters
                    ? [
                        {
                          label: "Mask parameters",
                          type: "readonly" as const,
                          mono: true,
                          format: () => term.maskParameters,
                        },
                      ]
                    : []),
                  ...term.maskOutputs.map((output, compIdx) => ({
                    label: (["Bx(r)", "By(r)", "Bz(r)"][compIdx] ??
                      `B${compIdx}(r)`),
                    type: "readonly" as const,
                    mono: true,
                    format: () => `${output} T`,
                  })),
                  {
                    label: "Time",
                    type: "readonly",
                    mono: true,
                    format: () => term.timeCall,
                  },
                  ...(term.timeParameters
                    ? [
                        {
                          label: "Time parameters",
                          type: "readonly" as const,
                          mono: true,
                          format: () => term.timeParameters,
                        },
                      ]
                    : []),
                  ...term.timeOutputs.map((output, outIdx) => ({
                    label:
                      term.timeOutputs.length > 1
                        ? `f_${outIdx + 1}(t)`
                        : "f(t)",
                    type: "readonly" as const,
                    mono: true,
                    format: () => output,
                  })),
                ],
              }),
            ),
          ];

    return {
      id: "study.stage.mask_field_drive",
      header: {
        breadcrumbs: stageBreadcrumbs(titleLabel),
        canFitView: true,
      },
      identity: {
        domain: "study",
        icon: Radar,
        title: (d) => d.driveName,
        kindLabel: "Mask antenna pipeline instruction",
        entityId: baseline.driveId,
        statePill: () => ({ tone: "info", label: "Read-only 0 s" }),
      },
      facts: (d): readonly InspectorFact[] => [
        {
          id: "act",
          label: "Action",
          value: d.actionKind === "update" ? "Update parameters" : "Add mask drive",
        },
        { id: "id", label: "Antenna ID", value: d.driveId },
        { id: "frame", label: "Frame", value: d.frame },
        { id: "clock", label: "Clock", value: d.timeOrigin },
      ],
      notices: () =>
        lastAuthoringError
          ? [{ id: "authoring-error", tone: "err", text: lastAuthoringError }]
          : [],
      sections: [
        {
          id: "pipeline",
          title: "Pipeline",
          icon: Workflow,
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <PipelineStrip
                  currentIndex={index}
                  steps={resolvedSteps}
                  onSelectStep={(step) => {
                    if (step.selection) ctx.selectNode(step.selection);
                  }}
                />
              ),
            },
            {
              label: "Stage ID",
              type: "readonly",
              mono: true,
              format: (d) => d.stageId,
            },
            ...(canTogglePipelineNode
              ? [
                  {
                    key: "stageEnabled" as const,
                    label: "Include pipeline node",
                    type: "switch" as const,
                  },
                ]
              : [
                  {
                    label: "Authoring mode",
                    type: "readonly" as const,
                    format: () => "Preserved losslessly (read-only)",
                  },
                ]),
          ],
        },
        ...termSections,
      ],
      commitBar: canTogglePipelineNode
        ? {
            mode: "staged",
            onApply: async (draft) => {
              if (onCommitStage) {
                return onCommitStage(draft);
              }
              return true;
            },
          }
        : {
            mode: "readOnly",
            statusMessage: () =>
              "Mask antenna stage payload is preserved losslessly in read-only mode",
          },
    };
  }, [
    baseline.actionKind,
    baseline.driveId,
    baseline.terms,
    canTogglePipelineNode,
    index,
    lastAuthoringError,
    onCommitStage,
    resolvedSteps,
    titleLabel,
  ]);

  return <StageSpecHost baseline={baseline} selection={selection} spec={spec} />;
}

/* ── 5. study.stage.table_autosave ──────────────────────────────────────── */

const TABLE_QUANTITY_PRESETS = [
  "t",
  "step",
  "mx",
  "my",
  "mz",
  "E_tot",
  "e_drive",
  "max_torque",
  "q_top",
] as const;

interface TableAutosaveDraft {
  stageId: string;
  stageEnabled: boolean;
  enabled: boolean;
  samplingMode: "explicit" | "auto_sinc_cutoff";
  samplePeriodS: number;
  tableQuantities: string;
  readOnly: boolean;
}

function splitCsvTokens(csv: string): string[] {
  return csv
    .split(",")
    .map((q) => q.trim())
    .filter(Boolean);
}

function toggleCsvQuantity(csv: string, token: string): string {
  const existing = splitCsvTokens(csv);
  if (existing.includes(token)) {
    return existing.filter((item) => item !== token).join(", ");
  }
  return [...existing, token].join(", ");
}

export function TableAutosaveStageInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  if (kernel) {
    return <ConnectedTableAutosaveStagePanel selection={selection} />;
  }
  return <TableAutosaveStageInspectorPanelView selection={selection} />;
}

function ConnectedTableAutosaveStagePanel({ selection }: InspectorPanelProps) {
  const {
    commitSelectedStageDraft,
    lastAuthoringError,
    pipelineStripSteps,
    selectedStageDraft,
    selectedStageIndex,
    stageDrafts,
  } = useKernelStudyAuthoring(selection);

  const clockContext = useMemo(() => {
    const stateBefore = resolveStudyWorkflowStateBefore(
      stageDrafts,
      selectedStageIndex,
    );
    const nextRunIndex = stageDrafts.findIndex(
      (s, i) => i > selectedStageIndex && s.kind === "run",
    );
    const nextRun = nextRunIndex >= 0 ? stageDrafts[nextRunIndex] : null;
    const effectiveState =
      nextRunIndex >= 0
        ? resolveStudyWorkflowStateBefore(stageDrafts, nextRunIndex)
        : null;
    const parsedDur = Number(nextRun?.untilSeconds);
    return {
      durationS: Number.isFinite(parsedDur) && parsedDur > 0 ? parsedDur : null,
      effectiveSampling: effectiveState?.tableAutosave ?? null,
      followingRunId: nextRun?.stageId ?? null,
      previousClockStageId: stateBefore.tableAutosave?.sourceStageId ?? null,
    };
  }, [selectedStageIndex, stageDrafts]);

  const hydratedBaseline = useMemo<TableAutosaveDraft>(() => {
    const d =
      selectedStageDraft?.kind === "table_autosave" ? selectedStageDraft : null;
    const ta = d?.tableAutosave;
    const stageId =
      d?.stageId ||
      (selection.ref?.type === "study-stage" && selection.ref.stageId
        ? selection.ref.stageId
        : `table_autosave_${selectedStageIndex + 1}`);
    return {
      stageId,
      stageEnabled: d?.stageEnabled ?? true,
      enabled: ta?.enabled ?? true,
      samplingMode:
        ta?.samplingMode === "auto_sinc_cutoff"
          ? "auto_sinc_cutoff"
          : "explicit",
      samplePeriodS: Number(ta?.samplePeriodS) || 5e-13,
      tableQuantities: ta?.tableQuantities ?? "t, step, mx, my, mz, e_drive",
      readOnly: ta?.readOnly ?? false,
    };
  }, [selectedStageDraft, selectedStageIndex, selection.ref]);

  return (
    <TableAutosaveStageInspectorPanelView
      clockContext={clockContext}
      hydratedBaseline={hydratedBaseline}
      lastAuthoringError={lastAuthoringError}
      pipelineNodeId={selectedStageDraft?.pipelineNodeId}
      pipelineStripSteps={pipelineStripSteps}
      selection={selection}
      onCommitStage={(draft) =>
        commitSelectedStageDraft(
          (base) => ({
            ...base,
            kind: "table_autosave",
            stageId: draft.stageId,
            stageEnabled: serializeStageEnabled(draft.stageEnabled, base),
            tableAutosave: draft.readOnly
              ? base.tableAutosave
              : {
                  ...base.tableAutosave,
                  enabled: draft.enabled,
                  samplingMode: draft.samplingMode,
                  samplePeriodS: String(draft.samplePeriodS),
                  tableQuantities: draft.tableQuantities,
                },
          }),
          "table_autosave",
        )
      }
    />
  );
}

function TableAutosaveStageInspectorPanelView({
  clockContext,
  hydratedBaseline,
  lastAuthoringError = null,
  onCommitStage,
  pipelineNodeId,
  pipelineStripSteps,
  selection,
}: InspectorPanelProps & {
  clockContext?: {
    durationS: number | null;
    effectiveSampling: EffectiveStudyTableAutosave | null;
    followingRunId: string | null;
    previousClockStageId: string | null;
  };
  hydratedBaseline?: TableAutosaveDraft;
  lastAuthoringError?: string | null;
  onCommitStage?: (draft: TableAutosaveDraft) => Promise<boolean>;
  pipelineNodeId?: string;
  pipelineStripSteps?: readonly PipelineStripStep[];
}) {
  const { index, stageId: fallbackId } = resolveStageMeta(selection, "table_autosave");
  const stageId = hydratedBaseline?.stageId ?? fallbackId;
  const titleLabel = `Table Autosave ${index + 1}`;

  const fallbackBaseline = useMemo<TableAutosaveDraft>(
    () => ({
      stageId,
      stageEnabled: true,
      enabled: true,
      samplingMode: "explicit",
      samplePeriodS: 5e-13,
      tableQuantities: "t, step, mx, my, mz, e_drive",
      readOnly: false,
    }),
    [stageId],
  );
  const baseline = hydratedBaseline ?? fallbackBaseline;

  const resolvedSteps = useMemo<readonly PipelineStripStep[]>(
    () =>
      pipelineStripSteps && pipelineStripSteps.length > 0
        ? pipelineStripSteps
        : fallbackPipelineSteps(
            stageId,
            index,
            "study.stage.table_autosave",
            "Table autosave",
          ),
    [index, pipelineStripSteps, stageId],
  );

  const spec = useMemo<InspectorSpec<TableAutosaveDraft>>(
    () => ({
      id: "study.stage.table_autosave",
      header: {
        breadcrumbs: stageBreadcrumbs(titleLabel),
      },
      identity: {
        domain: "study",
        icon: FileOutput,
        title: () => titleLabel,
        kindLabel: "Table sampling clock (0 s)",
        entityId: stageId,
        statePill: (d) =>
          d.readOnly
            ? { tone: "info", label: "Read-only" }
            : d.enabled
              ? { tone: "ok", label: "Clock ON" }
              : { tone: "neutral", label: "Clock OFF" },
      },
      facts: (d): readonly InspectorFact[] => {
        const cols = splitCsvTokens(d.tableQuantities);
        return [
          { id: "dur", label: "Duration", value: "0 s (config)" },
          {
            id: "dt",
            label: "Δt_sample",
            value: d.enabled
              ? d.samplingMode === "auto_sinc_cutoff"
                ? "Auto (sinc fc)"
                : formatTimeCompact(d.samplePeriodS)
              : "Stopped",
          },
          {
            id: "nyq",
            label: "Nyquist f_Nyq",
            value:
              d.enabled && d.samplingMode === "explicit" && d.samplePeriodS > 0
                ? formatFrequencyCompact(1 / (2 * d.samplePeriodS))
                : null,
          },
          { id: "cols", label: "Columns", value: `${cols.length} scalars` },
        ];
      },
      notices: (d) => {
        const list: InspectorNotice<TableAutosaveDraft>[] = [];
        if (lastAuthoringError) {
          list.push({
            id: "authoring-error",
            tone: "err",
            text: lastAuthoringError,
          });
        }
        if (d.readOnly) {
          list.push({
            id: "readonly-table-policy",
            tone: "warn",
            text: "Imported table sampling policy is unsupported by this editor and is preserved losslessly in read-only mode.",
          });
        }
        return list;
      },
      sections: [
        {
          id: "clock-config",
          title: "Table Clock Configuration",
          icon: Timer,
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <PipelineStrip
                  currentIndex={index}
                  steps={resolvedSteps}
                  onSelectStep={(step) => {
                    if (step.selection) ctx.selectNode(step.selection);
                  }}
                />
              ),
            },
            {
              key: "stageId",
              label: "Stage ID",
              type: "text",
              mono: true,
              disabledReason: (d) =>
                d.readOnly
                  ? "Imported table policy is preserved read-only."
                  : pipelineNodeId
                    ? "Canonical pipeline stage IDs are managed by the pipeline graph."
                    : null,
              validate: (val) => (!val.trim() ? "Stage ID is required." : null),
            },
            {
              key: "stageEnabled",
              label: "Include in study",
              type: "switch",
              disabledReason: (d) =>
                d.readOnly ? "Imported table policy is preserved read-only." : null,
            },
            {
              label: "Previous clock state",
              type: "readonly",
              format: () => clockContext?.previousClockStageId ?? "OFF",
            },
            {
              key: "enabled",
              label: "Enable table clock",
              type: "switch",
              structural: true,
              disabledReason: (d) =>
                d.readOnly ? "Imported table policy is preserved read-only." : null,
            },
            {
              key: "samplingMode",
              label: "Sampling mode",
              type: "segmented",
              structural: true,
              disabledReason: (d) =>
                d.readOnly ? "Imported table policy is preserved read-only." : null,
              showWhen: (d) => d.enabled,
              options: [
                { value: "explicit", label: "Explicit Δt" },
                { value: "auto_sinc_cutoff", label: "Auto from sinc fc" },
              ],
            },
            {
              key: "samplePeriodS",
              label: "Sample period",
              symbol: (
                <>
                  Δt<sub>sample</sub>
                </>
              ),
              type: "quantity",
              units: TIME_UNITS_SI,
              defaultDisplayUnit: "ps",
              min: 0,
              minExclusive: true,
              scrub: "log",
              disabledReason: (d) =>
                d.readOnly ? "Imported table policy is preserved read-only." : null,
              showWhen: (d) => d.enabled && d.samplingMode === "explicit",
            },
            {
              key: "tableQuantities",
              label: "Table quantities (comma-separated)",
              type: "text",
              mono: true,
              placeholder: "t, step, mx, my, mz, region:cap:mx",
              disabledReason: (d) =>
                d.readOnly ? "Imported table policy is preserved read-only." : null,
              showWhen: (d) => d.enabled,
              validate: (val, d) =>
                d.enabled && !d.readOnly && splitCsvTokens(val).length === 0
                  ? "Enter at least one table quantity."
                  : null,
            },
            {
              type: "custom",
              label: "Quick quantity presets",
              wide: true,
              showWhen: (d) => d.enabled && !d.readOnly,
              render: (ctx) => {
                const activeSet = new Set(splitCsvTokens(ctx.draft.tableQuantities));
                return (
                  <div className="flex flex-wrap gap-1">
                    {TABLE_QUANTITY_PRESETS.map((preset) => (
                      <Button
                        key={preset}
                        size="sm"
                        type="button"
                        variant={activeSet.has(preset) ? "primary" : "secondary"}
                        onClick={() =>
                          ctx.setField(
                            "tableQuantities",
                            toggleCsvQuantity(ctx.draft.tableQuantities, preset),
                          )
                        }
                      >
                        {preset}
                      </Button>
                    ))}
                  </div>
                );
              },
            },
          ],
        },
        {
          id: "response-fft-clock",
          title: "Response FFT Clock",
          icon: Activity,
          defaultOpen: true,
          rows: [
            {
              label: "Following Run",
              type: "readonly",
              mono: true,
              format: () => clockContext?.followingRunId ?? "none",
            },
            {
              type: "custom",
              wide: true,
              render: (ctx) => {
                const previewSampling: EffectiveStudyTableAutosave | null =
                  clockContext?.effectiveSampling ??
                  (ctx.draft.enabled
                    ? {
                        autoSampling: null,
                        quantities: splitCsvTokens(ctx.draft.tableQuantities),
                        samplePeriodS:
                          ctx.draft.samplingMode === "explicit"
                            ? ctx.draft.samplePeriodS
                            : null,
                        samplingMode: ctx.draft.samplingMode,
                        sourceDriveIds: [],
                        sourceStageId: ctx.draft.stageId,
                      }
                    : null);
                return (
                  <SamplingDiagnostics
                    durationS={clockContext?.durationS ?? null}
                    sampling={previewSampling}
                  />
                );
              },
            },
          ],
        },
      ],
      commitBar: {
        mode: baseline.readOnly ? "readOnly" : "staged",
        onApply: async (draft) => {
          if (onCommitStage) {
            return onCommitStage(draft);
          }
          return true;
        },
      },
    }),
    [
      baseline.readOnly,
      clockContext,
      index,
      lastAuthoringError,
      onCommitStage,
      pipelineNodeId,
      resolvedSteps,
      stageId,
      titleLabel,
    ],
  );

  return <StageSpecHost baseline={baseline} selection={selection} spec={spec} />;
}

/* ── 6. study.stage.autosave ────────────────────────────────────────────── */

const AUTOSAVE_QUANTITY_PRESETS = [
  "m",
  "B_eff",
  "B_demag",
  "B_exch",
  "H_drive",
  "e_total",
  "q_density",
] as const;

interface AutosaveDraft {
  stageId: string;
  stageEnabled: boolean;
  actionMode: "enable" | "disable" | "clear_all";
  quantity: string;
  outputKind: "field" | "scalar";
  samplingMode: "explicit" | "auto_sinc_cutoff";
  everySeconds: number;
  readOnly: boolean;
}

export function AutosaveStageInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  if (kernel) {
    return <ConnectedAutosaveStagePanel selection={selection} />;
  }
  return <AutosaveStageInspectorPanelView selection={selection} />;
}

function ConnectedAutosaveStagePanel({ selection }: InspectorPanelProps) {
  const {
    commitSelectedStageDraft,
    lastAuthoringError,
    pipelineStripSteps,
    selectedStageDraft,
    selectedStageIndex,
    stageDrafts,
  } = useKernelStudyAuthoring(selection);

  const hydratedBaseline = useMemo<AutosaveDraft>(() => {
    const d =
      selectedStageDraft?.kind === "autosave" ? selectedStageDraft : null;
    const a = d?.autosave;
    const stageId =
      d?.stageId ||
      (selection.ref?.type === "study-stage" && selection.ref.stageId
        ? selection.ref.stageId
        : `autosave_${selectedStageIndex + 1}`);
    return {
      stageId,
      stageEnabled: d?.stageEnabled ?? true,
      actionMode: a?.clearAll
        ? "clear_all"
        : a?.enabled === false
          ? "disable"
          : "enable",
      quantity: a?.clearAll ? "" : a?.quantity || "m",
      outputKind: a?.outputKind === "scalar" ? "scalar" : "field",
      samplingMode:
        a?.samplingMode === "auto_sinc_cutoff"
          ? "auto_sinc_cutoff"
          : "explicit",
      everySeconds: Number(a?.everySeconds) || 2e-12,
      readOnly: a?.readOnly ?? false,
    };
  }, [selectedStageDraft, selectedStageIndex, selection.ref]);

  const workflowContext = useMemo(() => {
    const stateBefore = resolveStudyWorkflowStateBefore(
      stageDrafts,
      selectedStageIndex,
    );
    const nextRunIndex = stageDrafts.findIndex(
      (s, i) => i > selectedStageIndex && s.kind === "run",
    );
    const nextRun = nextRunIndex >= 0 ? stageDrafts[nextRunIndex] : null;
    const effectiveState =
      nextRunIndex >= 0
        ? resolveStudyWorkflowStateBefore(stageDrafts, nextRunIndex)
        : null;
    const parsedDur = Number(nextRun?.untilSeconds);
    return {
      activeOutputsBefore:
        stateBefore.outputs.length > 0
          ? stateBefore.outputs.map((o) => o.quantity).join(", ")
          : "none",
      durationS: Number.isFinite(parsedDur) && parsedDur > 0 ? parsedDur : null,
      effectiveOutputs: effectiveState?.outputs ?? [],
      followingRunId: nextRun?.stageId ?? null,
    };
  }, [selectedStageIndex, stageDrafts]);

  return (
    <AutosaveStageInspectorPanelView
      hydratedBaseline={hydratedBaseline}
      lastAuthoringError={lastAuthoringError}
      pipelineNodeId={selectedStageDraft?.pipelineNodeId}
      pipelineStripSteps={pipelineStripSteps}
      selection={selection}
      workflowContext={workflowContext}
      onCommitStage={(draft) =>
        commitSelectedStageDraft(
          (base) => ({
            ...base,
            kind: "autosave",
            stageId: draft.stageId,
            stageEnabled: serializeStageEnabled(draft.stageEnabled, base),
            autosave: draft.readOnly
              ? base.autosave
              : {
                  ...base.autosave,
                  clearAll: draft.actionMode === "clear_all",
                  enabled: draft.actionMode === "enable",
                  quantity:
                    draft.actionMode === "clear_all"
                      ? ""
                      : draft.quantity.trim(),
                  outputKind: draft.outputKind,
                  samplingMode: draft.samplingMode,
                  everySeconds: String(draft.everySeconds),
                },
          }),
          "autosave",
        )
      }
    />
  );
}

function AutosaveStageInspectorPanelView({
  hydratedBaseline,
  lastAuthoringError = null,
  onCommitStage,
  pipelineNodeId,
  pipelineStripSteps,
  selection,
  workflowContext,
}: InspectorPanelProps & {
  hydratedBaseline?: AutosaveDraft;
  lastAuthoringError?: string | null;
  onCommitStage?: (draft: AutosaveDraft) => Promise<boolean>;
  pipelineNodeId?: string;
  pipelineStripSteps?: readonly PipelineStripStep[];
  workflowContext?: {
    activeOutputsBefore: string;
    durationS: number | null;
    effectiveOutputs: readonly EffectiveStudyAutosaveOutput[];
    followingRunId: string | null;
  };
}) {
  const { index, stageId: fallbackId } = resolveStageMeta(selection, "autosave");
  const stageId = hydratedBaseline?.stageId ?? fallbackId;
  const titleLabel = `Autosave ${index + 1}`;

  const fallbackBaseline = useMemo<AutosaveDraft>(
    () => ({
      stageId,
      stageEnabled: true,
      actionMode: "enable",
      quantity: "m",
      outputKind: "field",
      samplingMode: "explicit",
      everySeconds: 2e-12,
      readOnly: false,
    }),
    [stageId],
  );
  const baseline = hydratedBaseline ?? fallbackBaseline;

  const resolvedSteps = useMemo<readonly PipelineStripStep[]>(
    () =>
      pipelineStripSteps && pipelineStripSteps.length > 0
        ? pipelineStripSteps
        : fallbackPipelineSteps(stageId, index, "study.stage.autosave", "Autosave"),
    [index, pipelineStripSteps, stageId],
  );

  const spec = useMemo<InspectorSpec<AutosaveDraft>>(
    () => ({
      id: "study.stage.autosave",
      header: { breadcrumbs: stageBreadcrumbs(titleLabel) },
      identity: {
        domain: "study",
        icon: Database,
        title: () => titleLabel,
        kindLabel: "Field / scalar autosave instruction (0 s)",
        entityId: stageId,
        statePill: (d) =>
          d.readOnly
            ? { tone: "info", label: "Read-only" }
            : { tone: "ok", label: "0 s config" },
      },
      facts: (d): readonly InspectorFact[] => [
        { id: "dur", label: "Duration", value: "0 s (config)" },
        {
          id: "qty",
          label: "Quantity",
          value: d.actionMode === "clear_all" ? "Clear all" : d.quantity || "—",
        },
        {
          id: "carrier",
          label: "Carrier",
          value: d.outputKind === "field" ? "3D Field" : "Scalar",
        },
        {
          id: "cadence",
          label: "Cadence",
          value:
            d.actionMode === "enable"
              ? d.samplingMode === "auto_sinc_cutoff"
                ? "Auto (sinc fc)"
                : formatTimeCompact(d.everySeconds)
              : null,
        },
      ],
      notices: (d) => {
        const list: InspectorNotice<AutosaveDraft>[] = [];
        if (lastAuthoringError) {
          list.push({
            id: "authoring-error",
            tone: "err",
            text: lastAuthoringError,
          });
        }
        if (d.readOnly) {
          list.push({
            id: "readonly-autosave",
            tone: "warn",
            text: "Imported autosave output payload is unsupported by this editor and is preserved losslessly in read-only mode.",
          });
        }
        return list;
      },
      sections: [
        {
          id: "autosave-config",
          title: "Periodic Output Configuration",
          icon: Database,
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <PipelineStrip
                  currentIndex={index}
                  steps={resolvedSteps}
                  onSelectStep={(step) => {
                    if (step.selection) ctx.selectNode(step.selection);
                  }}
                />
              ),
            },
            {
              key: "stageId",
              label: "Stage ID",
              type: "text",
              mono: true,
              disabledReason: (d) =>
                d.readOnly
                  ? "Imported autosave output is preserved read-only."
                  : pipelineNodeId
                    ? "Canonical pipeline stage IDs are managed by the pipeline graph."
                    : null,
              validate: (val) => (!val.trim() ? "Stage ID is required." : null),
            },
            {
              key: "stageEnabled",
              label: "Include in study",
              type: "switch",
              disabledReason: (d) =>
                d.readOnly ? "Imported autosave output is preserved read-only." : null,
            },
            {
              label: "Currently active outputs",
              type: "readonly",
              mono: true,
              format: () => workflowContext?.activeOutputsBefore ?? "none",
            },
            {
              key: "actionMode",
              label: "Action mode",
              type: "segmented",
              structural: true,
              disabledReason: (d) =>
                d.readOnly ? "Imported autosave output is preserved read-only." : null,
              options: [
                { value: "enable", label: "Enable" },
                { value: "disable", label: "Disable one" },
                { value: "clear_all", label: "Clear all" },
              ],
            },
            {
              key: "quantity",
              label: "Quantity",
              type: "text",
              mono: true,
              placeholder: "m, B_eff, H_drive, region:cap:m",
              disabledReason: (d) =>
                d.readOnly ? "Imported autosave output is preserved read-only." : null,
              showWhen: (d) => d.actionMode !== "clear_all",
              validate: (val, d) =>
                d.actionMode !== "clear_all" && !d.readOnly && !val.trim()
                  ? "Quantity name is required unless clearing all outputs."
                  : null,
            },
            {
              type: "custom",
              label: "Standard quantities",
              wide: true,
              showWhen: (d) => d.actionMode !== "clear_all" && !d.readOnly,
              render: (ctx) => (
                <div className="flex flex-wrap gap-1">
                  {AUTOSAVE_QUANTITY_PRESETS.map((preset) => (
                    <Button
                      key={preset}
                      size="sm"
                      type="button"
                      variant={
                        ctx.draft.quantity.trim() === preset
                          ? "primary"
                          : "secondary"
                      }
                      onClick={() => ctx.setField("quantity", preset)}
                    >
                      {preset}
                    </Button>
                  ))}
                </div>
              ),
            },
            {
              key: "outputKind",
              label: "Output carrier",
              type: "segmented",
              disabledReason: (d) =>
                d.readOnly ? "Imported autosave output is preserved read-only." : null,
              showWhen: (d) => d.actionMode === "enable",
              options: [
                { value: "field", label: "Spatial 3D field" },
                { value: "scalar", label: "Reduced scalar" },
              ],
            },
            {
              key: "samplingMode",
              label: "Sampling mode",
              type: "segmented",
              structural: true,
              disabledReason: (d) =>
                d.readOnly ? "Imported autosave output is preserved read-only." : null,
              showWhen: (d) => d.actionMode === "enable",
              options: [
                { value: "explicit", label: "Explicit Δt" },
                { value: "auto_sinc_cutoff", label: "Auto from sinc fc" },
              ],
            },
            {
              key: "everySeconds",
              label: "Save interval",
              symbol: (
                <>
                  Δt<sub>out</sub>
                </>
              ),
              type: "quantity",
              units: TIME_UNITS_SI,
              defaultDisplayUnit: "ps",
              min: 0,
              minExclusive: true,
              scrub: "log",
              disabledReason: (d) =>
                d.readOnly ? "Imported autosave output is preserved read-only." : null,
              showWhen: (d) => d.actionMode === "enable" && d.samplingMode === "explicit",
            },
            {
              type: "custom",
              wide: true,
              showWhen: (d) => d.actionMode === "enable",
              render: (ctx) => {
                const matched =
                  workflowContext?.effectiveOutputs.find(
                    (o) => o.quantity === ctx.draft.quantity.trim(),
                  ) ?? {
                    autoSampling: null,
                    everySeconds:
                      ctx.draft.samplingMode === "explicit"
                        ? ctx.draft.everySeconds
                        : null,
                    outputKind: ctx.draft.outputKind,
                    quantity: ctx.draft.quantity.trim() || "m",
                    samplingMode: ctx.draft.samplingMode,
                    sourceDriveIds: [],
                    sourceStageId: ctx.draft.stageId,
                  };
                return (
                  <SamplingDiagnostics
                    durationS={workflowContext?.durationS ?? null}
                    sampling={matched}
                  />
                );
              },
            },
          ],
        },
      ],
      commitBar: {
        mode: baseline.readOnly ? "readOnly" : "staged",
        onApply: async (draft) => {
          if (onCommitStage) {
            return onCommitStage(draft);
          }
          return true;
        },
      },
    }),
    [
      baseline.readOnly,
      index,
      lastAuthoringError,
      onCommitStage,
      pipelineNodeId,
      resolvedSteps,
      stageId,
      titleLabel,
      workflowContext,
    ],
  );

  return (
    <StageSpecHost
      baseline={baseline}
      selection={selection}
      spec={spec}
      deriveFieldPatch={(key, value, nextDraft) => {
        if (
          key === "actionMode" &&
          value !== "clear_all" &&
          !nextDraft.quantity.trim()
        ) {
          return { quantity: "m" };
        }
        return null;
      }}
    />
  );
}

/* ── 7. study.stage.fft_response ────────────────────────────────────────── */

interface FftResponseDraft {
  stageId: string;
  stageEnabled: boolean;
  enabled: boolean;
  analysis: "gamma" | "finite_k" | "unsupported";
  responseComponent: "mx" | "my" | "mz";
  detrend: "none" | "mean" | "linear";
  floorFraction: number;
  probeCount: number;
  analysisXMinM: string;
  analysisXMaxM: string;
  readOnly: boolean;
}

export function FftResponseStageInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  if (kernel) {
    return <ConnectedFftResponseStagePanel selection={selection} />;
  }
  return <FftResponseStageInspectorPanelView selection={selection} />;
}

function ConnectedFftResponseStagePanel({ selection }: InspectorPanelProps) {
  const {
    commitSelectedStageDraft,
    lastAuthoringError,
    pipelineStripSteps,
    selectedStageDraft,
    selectedStageIndex,
    stageDrafts,
  } = useKernelStudyAuthoring(selection);

  const effectiveClockInfo = useMemo(() => {
    const stateBefore = resolveStudyWorkflowStateBefore(
      stageDrafts,
      selectedStageIndex,
    );
    const nextRunIdx = stageDrafts.findIndex(
      (s, i) => i > selectedStageIndex && s.kind === "run",
    );
    const effectiveState =
      nextRunIdx >= 0
        ? resolveStudyWorkflowStateBefore(stageDrafts, nextRunIdx)
        : stateBefore;
    const nextRun = nextRunIdx >= 0 ? stageDrafts[nextRunIdx] : null;
    const dur = Number(nextRun?.untilSeconds);
    return {
      durationS: Number.isFinite(dur) && dur > 0 ? dur : null,
      followingRunId: nextRun?.stageId ?? null,
      hDriveFieldClock:
        effectiveState.outputs.find(
          (o) => o.quantity === "H_drive" && o.outputKind === "field",
        ) ?? null,
      mFieldClock:
        effectiveState.outputs.find(
          (o) => o.quantity === "m" && o.outputKind === "field",
        ) ?? null,
      tableClock: effectiveState.tableAutosave,
    };
  }, [selectedStageIndex, stageDrafts]);

  const hydratedBaseline = useMemo<FftResponseDraft>(() => {
    const d =
      selectedStageDraft?.kind === "fft_response" ? selectedStageDraft : null;
    const f = d?.fftResponse;
    const stageId =
      d?.stageId ||
      (selection.ref?.type === "study-stage" && selection.ref.stageId
        ? selection.ref.stageId
        : `fft_response_${selectedStageIndex + 1}`);
    const analysis: FftResponseDraft["analysis"] =
      f?.analysis === "finite_k"
        ? "finite_k"
        : f?.analysis === "unsupported"
          ? "unsupported"
          : "gamma";
    const responseComponent: FftResponseDraft["responseComponent"] =
      analysis === "finite_k" && f?.responseComponent === "mx"
        ? "mx"
        : f?.responseComponent === "mz"
          ? "mz"
          : "my";
    return {
      stageId,
      stageEnabled: d?.stageEnabled ?? true,
      enabled: f?.enabled ?? true,
      analysis,
      responseComponent,
      detrend:
        f?.detrend === "none" || f?.detrend === "mean" ? f.detrend : "linear",
      floorFraction: Number(f?.susceptibilityFloorFraction) || 1e-6,
      probeCount: Number(f?.probeCount) || 128,
      analysisXMinM: f?.analysisXMinM ?? "",
      analysisXMaxM: f?.analysisXMaxM ?? "",
      readOnly: f?.readOnly ?? analysis === "unsupported",
    };
  }, [selectedStageDraft, selectedStageIndex, selection.ref]);

  return (
    <FftResponseStageInspectorPanelView
      clockInfo={effectiveClockInfo}
      hydratedBaseline={hydratedBaseline}
      lastAuthoringError={lastAuthoringError}
      pipelineNodeId={selectedStageDraft?.pipelineNodeId}
      pipelineStripSteps={pipelineStripSteps}
      selection={selection}
      onCommitStage={(draft) =>
        commitSelectedStageDraft(
          (base) => ({
            ...base,
            kind: "fft_response",
            stageId: draft.stageId,
            stageEnabled: serializeStageEnabled(draft.stageEnabled, base),
            fftResponse: draft.readOnly
              ? base.fftResponse
              : {
                  ...base.fftResponse,
                  enabled: draft.enabled,
                  analysis: draft.analysis === "finite_k" ? "finite_k" : "gamma",
                  responseComponent:
                    draft.analysis === "gamma" &&
                    draft.responseComponent === "mx"
                      ? "my"
                      : draft.responseComponent,
                  detrend: draft.detrend,
                  susceptibilityFloorFraction: String(draft.floorFraction),
                  probeCount: String(draft.probeCount),
                  analysisXMinM: draft.analysisXMinM.trim(),
                  analysisXMaxM: draft.analysisXMaxM.trim(),
                },
          }),
          "fft_response",
        )
      }
    />
  );
}

function FftResponseStageInspectorPanelView({
  clockInfo,
  hydratedBaseline,
  lastAuthoringError = null,
  onCommitStage,
  pipelineNodeId,
  pipelineStripSteps,
  selection,
}: InspectorPanelProps & {
  clockInfo?: {
    durationS: number | null;
    followingRunId: string | null;
    hDriveFieldClock: EffectiveStudyAutosaveOutput | null;
    mFieldClock: EffectiveStudyAutosaveOutput | null;
    tableClock: EffectiveStudyTableAutosave | null;
  };
  hydratedBaseline?: FftResponseDraft;
  lastAuthoringError?: string | null;
  onCommitStage?: (draft: FftResponseDraft) => Promise<boolean>;
  pipelineNodeId?: string;
  pipelineStripSteps?: readonly PipelineStripStep[];
}) {
  const { index, stageId: fallbackId } = resolveStageMeta(selection, "fft_response");
  const stageId = hydratedBaseline?.stageId ?? fallbackId;
  const titleLabel = `FFT Response ${index + 1}`;

  const fallbackBaseline = useMemo<FftResponseDraft>(
    () => ({
      stageId,
      stageEnabled: true,
      enabled: true,
      analysis: "gamma",
      responseComponent: "my",
      detrend: "linear",
      floorFraction: 1e-6,
      probeCount: 128,
      analysisXMinM: "",
      analysisXMaxM: "",
      readOnly: false,
    }),
    [stageId],
  );
  const baseline = hydratedBaseline ?? fallbackBaseline;

  const resolvedSteps = useMemo<readonly PipelineStripStep[]>(
    () =>
      pipelineStripSteps && pipelineStripSteps.length > 0
        ? pipelineStripSteps
        : fallbackPipelineSteps(
            stageId,
            index,
            "study.stage.fft_response",
            "FFT response",
          ),
    [index, pipelineStripSteps, stageId],
  );

  const spec = useMemo<InspectorSpec<FftResponseDraft>>(
    () => ({
      id: "study.stage.fft_response",
      header: { breadcrumbs: stageBreadcrumbs(titleLabel) },
      identity: {
        domain: "study",
        icon: Waves,
        title: () => titleLabel,
        kindLabel: "Spin-wave FFT postprocessing instruction (0 s)",
        entityId: stageId,
        statePill: (d) =>
          d.readOnly
            ? { tone: "info", label: "Read-only" }
            : d.enabled
              ? { tone: "ok", label: "FFT ON" }
              : { tone: "neutral", label: "FFT OFF" },
      },
      facts: (d): readonly InspectorFact[] => [
        { id: "dur", label: "Duration", value: "0 s (config)" },
        {
          id: "mode",
          label: "Analysis",
          value:
            d.analysis === "finite_k"
              ? "Finite-k S(kx, f)"
              : d.analysis === "unsupported"
                ? "Preserved custom"
                : "Gamma (k = 0)",
        },
        { id: "comp", label: "Component", value: d.responseComponent },
        { id: "win", label: "Window", value: "Hann" },
      ],
      notices: (d) => {
        const list: InspectorNotice<FftResponseDraft>[] = [];
        if (lastAuthoringError) {
          list.push({
            id: "authoring-error",
            tone: "err",
            text: lastAuthoringError,
          });
        }
        if (d.readOnly || d.analysis === "unsupported") {
          list.push({
            id: "readonly-fft",
            tone: "warn",
            text: "Imported FFT response request is unsupported by this editor and is preserved losslessly in read-only mode.",
          });
        }
        if (d.enabled && d.analysis === "finite_k" && !d.readOnly) {
          list.push({
            id: "finite-k-info",
            tone: "info",
            text: "Finite-k response requires FEM tet4/FP64 field snapshots of m and H_drive on matching time clocks.",
          });
        }
        if (
          clockInfo &&
          d.enabled &&
          d.analysis === "gamma" &&
          !clockInfo.tableClock
        ) {
          list.push({
            id: "missing-table-clock",
            tone: "warn",
            text: "FFT response requires a preceding Table Autosave ON stage to define Δt_sample before the following Run.",
          });
        }
        if (
          clockInfo &&
          d.enabled &&
          d.analysis === "finite_k" &&
          (!clockInfo.mFieldClock || !clockInfo.hDriveFieldClock)
        ) {
          list.push({
            id: "missing-finite-k-clocks",
            tone: "warn",
            text: "Finite-k response requires preceding 3D field Autosave instructions for both m and H_drive.",
          });
        }
        return list;
      },
      sections: [
        {
          id: "fft-config",
          title: "Spectral Transform Configuration",
          icon: Waves,
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <PipelineStrip
                  currentIndex={index}
                  steps={resolvedSteps}
                  onSelectStep={(step) => {
                    if (step.selection) ctx.selectNode(step.selection);
                  }}
                />
              ),
            },
            {
              key: "stageId",
              label: "Stage ID",
              type: "text",
              mono: true,
              disabledReason: (d) =>
                d.readOnly
                  ? "Imported FFT request is preserved read-only."
                  : pipelineNodeId
                    ? "Canonical pipeline stage IDs are managed by the pipeline graph."
                    : null,
              validate: (val) => (!val.trim() ? "Stage ID is required." : null),
            },
            {
              key: "stageEnabled",
              label: "Include in study",
              type: "switch",
              disabledReason: (d) =>
                d.readOnly ? "Imported FFT request is preserved read-only." : null,
            },
            {
              key: "enabled",
              label: "Compute response FFT",
              type: "switch",
              structural: true,
              disabledReason: (d) =>
                d.readOnly ? "Imported FFT request is preserved read-only." : null,
            },
            {
              key: "analysis",
              label: "Analysis mode",
              type: "segmented",
              structural: true,
              disabledReason: (d) =>
                d.readOnly ? "Imported FFT request is preserved read-only." : null,
              showWhen: (d) => d.enabled && d.analysis !== "unsupported",
              options: [
                { value: "gamma", label: "Uniform k = 0 FMR" },
                { value: "finite_k", label: "Finite-k S(kₓ, f)" },
              ],
            },
            {
              key: "responseComponent",
              label: "Response component",
              type: "segmented",
              disabledReason: (d) =>
                d.readOnly ? "Imported FFT request is preserved read-only." : null,
              showWhen: (d) => d.enabled && d.analysis === "gamma",
              options: [
                { value: "my", label: "my" },
                { value: "mz", label: "mz" },
              ],
            },
            {
              key: "responseComponent",
              label: "Response component",
              type: "segmented",
              disabledReason: (d) =>
                d.readOnly ? "Imported FFT request is preserved read-only." : null,
              showWhen: (d) => d.enabled && d.analysis === "finite_k",
              options: [
                { value: "mx", label: "mx" },
                { value: "my", label: "my" },
                { value: "mz", label: "mz" },
              ],
            },
            {
              key: "detrend",
              label: "Detrending",
              type: "select",
              disabledReason: (d) =>
                d.readOnly ? "Imported FFT request is preserved read-only." : null,
              showWhen: (d) => d.enabled && d.analysis === "gamma",
              options: [
                { value: "none", label: "None" },
                { value: "mean", label: "Subtract mean" },
                { value: "linear", label: "Subtract linear trend" },
              ],
            },
            {
              key: "floorFraction",
              label: "Susceptibility floor",
              type: "number",
              min: 0,
              max: 0.99,
              scrub: "log",
              disabledReason: (d) =>
                d.readOnly ? "Imported FFT request is preserved read-only." : null,
              showWhen: (d) => d.enabled && d.analysis === "gamma",
            },
            {
              key: "probeCount",
              label: "Spatial probe count",
              symbol: (
                <>
                  N<sub>x</sub>
                </>
              ),
              type: "number",
              integer: true,
              min: 4,
              max: 2048,
              disabledReason: (d) =>
                d.readOnly ? "Imported FFT request is preserved read-only." : null,
              showWhen: (d) => d.enabled && d.analysis === "finite_k",
            },
            {
              key: "analysisXMinM",
              label: "Lower x bound (m, blank = full geometry)",
              type: "text",
              mono: true,
              placeholder: "Infer from geometry bounds",
              disabledReason: (d) =>
                d.readOnly ? "Imported FFT request is preserved read-only." : null,
              showWhen: (d) => d.enabled && d.analysis === "finite_k",
              validate: (val) =>
                val.trim() && !Number.isFinite(Number(val))
                  ? "Lower x bound must be a finite number in metres or left blank."
                  : null,
            },
            {
              key: "analysisXMaxM",
              label: "Upper x bound (m, blank = full geometry)",
              type: "text",
              mono: true,
              placeholder: "Infer from geometry bounds",
              disabledReason: (d) =>
                d.readOnly ? "Imported FFT request is preserved read-only." : null,
              showWhen: (d) => d.enabled && d.analysis === "finite_k",
              validate: (val, d) => {
                if (!val.trim()) return null;
                const upper = Number(val);
                if (!Number.isFinite(upper)) {
                  return "Upper x bound must be a finite number in metres or left blank.";
                }
                if (d.analysisXMinM.trim()) {
                  const lower = Number(d.analysisXMinM);
                  if (Number.isFinite(lower) && upper <= lower) {
                    return "Upper x bound must exceed lower x bound.";
                  }
                }
                return null;
              },
            },
          ],
        },
        {
          id: "effective-response-clock",
          title: "Effective Response Clock",
          icon: Timer,
          defaultOpen: true,
          rows: [
            {
              label: "Clock source",
              type: "readonly",
              mono: true,
              format: (d) =>
                d.analysis === "unsupported"
                  ? "not inferred for preserved request"
                  : d.analysis === "finite_k"
                    ? (clockInfo?.mFieldClock?.sourceStageId ??
                      "no m field autosave before following Run")
                    : (clockInfo?.tableClock?.sourceStageId ??
                      "no Table Autosave ON stage before following Run"),
            },
            {
              label: "H_drive field clock",
              type: "readonly",
              mono: true,
              showWhen: (d) => d.analysis === "finite_k",
              format: () =>
                clockInfo?.hDriveFieldClock?.sourceStageId ??
                "missing H_drive field autosave",
            },
            {
              label: "Following Run",
              type: "readonly",
              mono: true,
              format: () => clockInfo?.followingRunId ?? "none",
            },
            {
              type: "custom",
              wide: true,
              render: (ctx) => {
                const effectiveSampling =
                  ctx.draft.analysis === "unsupported"
                    ? null
                    : ctx.draft.analysis === "finite_k"
                      ? (clockInfo?.mFieldClock ?? null)
                      : (clockInfo?.tableClock ?? null);
                return (
                  <SamplingDiagnostics
                    durationS={clockInfo?.durationS ?? null}
                    sampling={effectiveSampling}
                  />
                );
              },
            },
          ],
        },
      ],
      commitBar: {
        mode: baseline.readOnly ? "readOnly" : "staged",
        onApply: async (draft) => {
          if (onCommitStage) {
            return onCommitStage(draft);
          }
          return true;
        },
      },
    }),
    [
      baseline.readOnly,
      clockInfo,
      index,
      lastAuthoringError,
      onCommitStage,
      pipelineNodeId,
      resolvedSteps,
      stageId,
      titleLabel,
    ],
  );

  return (
    <StageSpecHost
      baseline={baseline}
      selection={selection}
      spec={spec}
      deriveFieldPatch={(key, value, nextDraft) => {
        if (
          key === "analysis" &&
          value === "gamma" &&
          nextDraft.responseComponent === "mx"
        ) {
          return { responseComponent: "my" as const };
        }
        return null;
      }}
    />
  );
}

/* ── 8. study.stage.save_state ──────────────────────────────────────────── */

const SAVE_STATE_FORMAT_PRESETS: ReadonlyArray<{
  readonly value: string;
  readonly label: string;
}> = [
  { value: "", label: "Default" },
  { value: "zarr", label: "zarr" },
  { value: "ovf", label: "ovf" },
  { value: "npz", label: "npz" },
  { value: "hdf5", label: "hdf5" },
  { value: "fms", label: "fms" },
];

interface SaveStateDraft {
  stageId: string;
  stageEnabled: boolean;
  artifactName: string;
  format: string;
  dataset: string;
}

export function SaveStateStageInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  if (kernel) {
    return <ConnectedSaveStateStagePanel selection={selection} />;
  }
  return <SaveStateStageInspectorPanelView selection={selection} />;
}

function ConnectedSaveStateStagePanel({ selection }: InspectorPanelProps) {
  const {
    commitSelectedStageDraft,
    lastAuthoringError,
    pipelineStripSteps,
    selectedStageDraft,
    selectedStageIndex,
  } = useKernelStudyAuthoring(selection);

  const hydratedBaseline = useMemo<SaveStateDraft>(() => {
    const d =
      selectedStageDraft?.kind === "save_state" ? selectedStageDraft : null;
    const stageId =
      d?.stageId ||
      (selection.ref?.type === "study-stage" && selection.ref.stageId
        ? selection.ref.stageId
        : `save_state_${selectedStageIndex + 1}`);
    return {
      stageId,
      stageEnabled: d?.stageEnabled ?? true,
      artifactName: d?.artifactName || "state_snapshot",
      format: d ? d.format : "",
      dataset: d ? d.dataset : "",
    };
  }, [selectedStageDraft, selectedStageIndex, selection.ref]);

  return (
    <SaveStateStageInspectorPanelView
      hydratedBaseline={hydratedBaseline}
      lastAuthoringError={lastAuthoringError}
      pipelineNodeId={selectedStageDraft?.pipelineNodeId}
      pipelineStripSteps={pipelineStripSteps}
      selection={selection}
      onCommitStage={(draft) =>
        commitSelectedStageDraft(
          (base) => ({
            ...base,
            kind: "save_state",
            stageId: draft.stageId,
            stageEnabled: serializeStageEnabled(draft.stageEnabled, base),
            artifactName: draft.artifactName,
            format: draft.format.trim(),
            dataset: draft.dataset.trim(),
          }),
          "save_state",
        )
      }
    />
  );
}

function SaveStateStageInspectorPanelView({
  hydratedBaseline,
  lastAuthoringError = null,
  onCommitStage,
  pipelineNodeId,
  pipelineStripSteps,
  selection,
}: InspectorPanelProps & {
  hydratedBaseline?: SaveStateDraft;
  lastAuthoringError?: string | null;
  onCommitStage?: (draft: SaveStateDraft) => Promise<boolean>;
  pipelineNodeId?: string;
  pipelineStripSteps?: readonly PipelineStripStep[];
}) {
  const { index, stageId: fallbackId } = resolveStageMeta(selection, "save_state");
  const stageId = hydratedBaseline?.stageId ?? fallbackId;
  const titleLabel = `Save State ${index + 1}`;

  const fallbackBaseline = useMemo<SaveStateDraft>(
    () => ({
      stageId,
      stageEnabled: true,
      artifactName: "state_snapshot",
      format: "",
      dataset: "",
    }),
    [stageId],
  );
  const baseline = hydratedBaseline ?? fallbackBaseline;

  const resolvedSteps = useMemo<readonly PipelineStripStep[]>(
    () =>
      pipelineStripSteps && pipelineStripSteps.length > 0
        ? pipelineStripSteps
        : fallbackPipelineSteps(
            stageId,
            index,
            "study.stage.save_state",
            "Save state",
          ),
    [index, pipelineStripSteps, stageId],
  );

  const spec = useMemo<InspectorSpec<SaveStateDraft>>(
    () => ({
      id: "study.stage.save_state",
      header: { breadcrumbs: stageBreadcrumbs(titleLabel) },
      identity: {
        domain: "study",
        icon: Database,
        title: () => titleLabel,
        kindLabel: "State snapshot instruction (0 s)",
        entityId: stageId,
        statePill: () => ({ tone: "ok", label: "0 s snapshot" }),
      },
      facts: (d): readonly InspectorFact[] => [
        { id: "dur", label: "Duration", value: "0 s (config)" },
        { id: "art", label: "Artifact", value: d.artifactName },
        {
          id: "fmt",
          label: "Format",
          value: d.format.trim() ? d.format.trim().toUpperCase() : "Session default",
        },
      ],
      notices: () =>
        lastAuthoringError
          ? [{ id: "authoring-error", tone: "err", text: lastAuthoringError }]
          : [],
      sections: [
        {
          id: "snapshot-target",
          title: "Snapshot Output Target",
          icon: Database,
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <PipelineStrip
                  currentIndex={index}
                  steps={resolvedSteps}
                  onSelectStep={(step) => {
                    if (step.selection) ctx.selectNode(step.selection);
                  }}
                />
              ),
            },
            {
              key: "stageId",
              label: "Stage ID",
              type: "text",
              mono: true,
              disabledReason: () =>
                pipelineNodeId
                  ? "Canonical pipeline stage IDs are managed by the pipeline graph."
                  : null,
              validate: (val) => (!val.trim() ? "Stage ID is required." : null),
            },
            { key: "stageEnabled", label: "Include in study", type: "switch" },
            {
              key: "artifactName",
              label: "Artifact name",
              type: "text",
              mono: true,
              validate: (val) => (!val.trim() ? "Artifact name is required." : null),
            },
            {
              key: "format",
              label: "Archive format (blank = session default)",
              type: "text",
              mono: true,
              placeholder: "zarr, ovf, npz, hdf5, or blank",
            },
            {
              type: "custom",
              label: "Format presets",
              wide: true,
              render: (ctx) => (
                <div className="flex flex-wrap gap-1">
                  {SAVE_STATE_FORMAT_PRESETS.map((preset) => (
                    <Button
                      key={preset.value || "__default"}
                      size="sm"
                      type="button"
                      variant={
                        ctx.draft.format.trim() === preset.value
                          ? "primary"
                          : "secondary"
                      }
                      onClick={() => ctx.setField("format", preset.value)}
                    >
                      {preset.label}
                    </Button>
                  ))}
                </div>
              ),
            },
            {
              key: "dataset",
              label: "Dataset key (optional)",
              type: "text",
              mono: true,
              placeholder: "Blank for default magnetization dataset",
            },
          ],
        },
      ],
      commitBar: {
        mode: "staged",
        onApply: async (draft) => {
          if (onCommitStage) {
            return onCommitStage(draft);
          }
          return true;
        },
      },
    }),
    [
      index,
      lastAuthoringError,
      onCommitStage,
      pipelineNodeId,
      resolvedSteps,
      stageId,
      titleLabel,
    ],
  );

  return <StageSpecHost baseline={baseline} selection={selection} spec={spec} />;
}

/* ── 9. study.stage.change_device ───────────────────────────────────────── */

interface ChangeDeviceDraft {
  stageId: string;
  stageEnabled: boolean;
  devicePreset: "auto" | "gpu" | "cuda" | "cuda_indexed" | "cpu";
  cudaDeviceIndex: number;
}

function parseDeviceTargetDraft(raw: string | undefined): {
  devicePreset: ChangeDeviceDraft["devicePreset"];
  cudaDeviceIndex: number;
} {
  const normalized = (raw ?? "gpu").trim().toLowerCase();
  if (normalized === "cpu") return { devicePreset: "cpu", cudaDeviceIndex: 0 };
  if (normalized === "auto") return { devicePreset: "auto", cudaDeviceIndex: 0 };
  if (normalized === "cuda") return { devicePreset: "cuda", cudaDeviceIndex: 0 };
  if (normalized.startsWith("cuda:")) {
    const idxText = normalized.slice("cuda:".length);
    if (/^[0-9]+$/.test(idxText)) {
      return {
        devicePreset: "cuda_indexed",
        cudaDeviceIndex: Number.parseInt(idxText, 10),
      };
    }
  }
  return { devicePreset: "gpu", cudaDeviceIndex: 0 };
}

function serializeDeviceTargetDraft(draft: ChangeDeviceDraft): string {
  if (draft.devicePreset === "cuda_indexed") {
    return `cuda:${Math.max(0, Math.round(draft.cudaDeviceIndex || 0))}`;
  }
  return draft.devicePreset;
}

export function ChangeDeviceStageInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  if (kernel) {
    return <ConnectedChangeDeviceStagePanel selection={selection} />;
  }
  return <ChangeDeviceStageInspectorPanelView selection={selection} />;
}

function ConnectedChangeDeviceStagePanel({ selection }: InspectorPanelProps) {
  const {
    commitSelectedStageDraft,
    executionProfileBound,
    lastAuthoringError,
    pipelineStripSteps,
    selectedStageDraft,
    selectedStageIndex,
  } = useKernelStudyAuthoring(selection);

  const hydratedBaseline = useMemo<ChangeDeviceDraft>(() => {
    const d =
      selectedStageDraft?.kind === "change_device" ? selectedStageDraft : null;
    const stageId =
      d?.stageId ||
      (selection.ref?.type === "study-stage" && selection.ref.stageId
        ? selection.ref.stageId
        : `change_device_${selectedStageIndex + 1}`);
    const parsed = parseDeviceTargetDraft(d?.deviceTarget ?? "cpu");
    return {
      stageId,
      stageEnabled: d?.stageEnabled ?? true,
      devicePreset: parsed.devicePreset,
      cudaDeviceIndex: parsed.cudaDeviceIndex,
    };
  }, [selectedStageDraft, selectedStageIndex, selection.ref]);

  return (
    <StudyStageTelemetryBridge selection={selection}>
      {(selectedStageModel) => (
        <ChangeDeviceStageInspectorPanelView
          executionProfileBound={executionProfileBound}
          hydratedBaseline={hydratedBaseline}
          lastAuthoringError={lastAuthoringError}
          pipelineNodeId={selectedStageDraft?.pipelineNodeId}
          pipelineStripSteps={pipelineStripSteps}
          selection={selection}
          stageModel={selectedStageModel}
          onCommitStage={(draft) =>
            commitSelectedStageDraft(
              (base) => ({
                ...base,
                kind: "change_device",
                stageId: draft.stageId,
                stageEnabled: serializeStageEnabled(draft.stageEnabled, base),
                deviceTarget: serializeDeviceTargetDraft(draft),
              }),
              "change_device",
            )
          }
        />
      )}
    </StudyStageTelemetryBridge>
  );
}

function ChangeDeviceStageInspectorPanelView({
  executionProfileBound = false,
  hydratedBaseline,
  lastAuthoringError = null,
  onCommitStage,
  pipelineNodeId,
  pipelineStripSteps,
  selection,
  stageModel = null,
}: InspectorPanelProps & {
  executionProfileBound?: boolean;
  hydratedBaseline?: ChangeDeviceDraft;
  lastAuthoringError?: string | null;
  onCommitStage?: (draft: ChangeDeviceDraft) => Promise<boolean>;
  pipelineNodeId?: string;
  pipelineStripSteps?: readonly PipelineStripStep[];
  stageModel?: StudyStageModel | null;
}) {
  const { index, stageId: fallbackId } = resolveStageMeta(selection, "change_device");
  const stageId = hydratedBaseline?.stageId ?? fallbackId;
  const titleLabel = `Change Device ${index + 1}`;

  const fallbackBaseline = useMemo<ChangeDeviceDraft>(
    () => ({
      stageId,
      stageEnabled: true,
      devicePreset: "gpu",
      cudaDeviceIndex: 0,
    }),
    [stageId],
  );
  const baseline = hydratedBaseline ?? fallbackBaseline;

  const resolvedSteps = useMemo<readonly PipelineStripStep[]>(
    () =>
      pipelineStripSteps && pipelineStripSteps.length > 0
        ? pipelineStripSteps
        : fallbackPipelineSteps(
            stageId,
            index,
            "study.stage.change_device",
            "Change device",
          ),
    [index, pipelineStripSteps, stageId],
  );

  const spec = useMemo<InspectorSpec<ChangeDeviceDraft>>(
    () => ({
      id: "study.stage.change_device",
      header: { breadcrumbs: stageBreadcrumbs(titleLabel) },
      identity: {
        domain: "study",
        icon: Cpu,
        title: () => titleLabel,
        kindLabel: "Device handoff instruction (0 s)",
        entityId: stageId,
        statePill: () =>
          executionProfileBound
            ? { tone: "warn", label: "Profile bound" }
            : { tone: "ok", label: "0 s handoff" },
      },
      facts: (d): readonly InspectorFact[] => {
        const target = serializeDeviceTargetDraft(d);
        return [
          { id: "dur", label: "Duration", value: "0 s (config)" },
          {
            id: "target",
            label: "Target device",
            value:
              target === "gpu" || target.startsWith("cuda")
                ? `${target.toUpperCase()} (strict)`
                : target.toUpperCase(),
          },
        ];
      },
      notices: () => {
        const list: InspectorNotice<ChangeDeviceDraft>[] = [];
        if (lastAuthoringError) {
          list.push({
            id: "authoring-error",
            tone: "err",
            text: lastAuthoringError,
          });
        }
        if (executionProfileBound) {
          list.push({
            id: "execution-profile-conflict",
            tone: "warn",
            text: "This Study is bound to an execution profile. Stage-level Change Device instructions conflict with profile-managed device placement.",
          });
        }
        return list;
      },
      sections: [
        {
          id: "device-handoff",
          title: "Execution Device Transition",
          icon: Cpu,
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <PipelineStrip
                  currentIndex={index}
                  steps={resolvedSteps}
                  onSelectStep={(step) => {
                    if (step.selection) ctx.selectNode(step.selection);
                  }}
                />
              ),
            },
            {
              key: "stageId",
              label: "Stage ID",
              type: "text",
              mono: true,
              disabledReason: () =>
                pipelineNodeId
                  ? "Canonical pipeline stage IDs are managed by the pipeline graph."
                  : null,
              validate: (val) => (!val.trim() ? "Stage ID is required." : null),
            },
            { key: "stageEnabled", label: "Include in study", type: "switch" },
            {
              key: "devicePreset",
              label: "Target execution device",
              type: "select",
              structural: true,
              options: [
                { value: "auto", label: "Auto" },
                { value: "gpu", label: "GPU (CUDA)" },
                { value: "cuda", label: "CUDA explicit" },
                { value: "cuda_indexed", label: "CUDA indexed (cuda:N)" },
                { value: "cpu", label: "CPU" },
              ],
            },
            {
              key: "cudaDeviceIndex",
              label: "CUDA device index",
              type: "number",
              integer: true,
              min: 0,
              max: 63,
              showWhen: (d) => d.devicePreset === "cuda_indexed",
            },
            {
              label: "Python DSL",
              type: "readonly",
              mono: true,
              format: (d) =>
                `study.stages.change_device("${serializeDeviceTargetDraft(d)}")`,
            },
            {
              label: "State transfer operator",
              type: "readonly",
              format: (d) =>
                stageModel?.transition?.transferOperator ??
                (d.devicePreset === "cpu"
                  ? "Device-to-Host exact buffer copy"
                  : "Host-to-Device exact buffer copy (strict CUDA)"),
            },
            {
              label: "Runtime transition status",
              type: "readonly",
              format: () => stageModel?.status ?? "not started",
            },
          ],
        },
      ],
      commitBar: {
        mode: "staged",
        onApply: async (draft) => {
          if (onCommitStage) {
            return onCommitStage(draft);
          }
          return true;
        },
      },
    }),
    [
      executionProfileBound,
      index,
      lastAuthoringError,
      onCommitStage,
      pipelineNodeId,
      resolvedSteps,
      stageId,
      stageModel?.status,
      stageModel?.transition?.transferOperator,
      titleLabel,
    ],
  );

  return <StageSpecHost baseline={baseline} selection={selection} spec={spec} />;
}

/* ── 10. study.stage.antenna_field_solve ─────────────────────────────────── */

interface AntennaFieldSolveStageDraft {
  definitionId: string;
  antennaObjectId: string;
  currentTransportId: string;
  portModeId: string;
  modelName: string;
  oerstedRealization: string;
  solverPolicy: string;
  declaredOutputs: string;
  hasDefinition: boolean;
  bound: boolean;
  errorMessage: string | null;
}

function buildAntennaFieldSolveViewDraft(
  sceneData: SceneResource | null,
  rawStage: Record<string, unknown> | null | undefined,
): AntennaFieldSolveStageDraft {
  const definitionId =
    typeof rawStage?.stage_id === "string" && rawStage.stage_id.trim()
      ? rawStage.stage_id
      : null;
  const matches = (sceneData?.antenna_field_solve_stages ?? []).filter(
    (def) => def.id === definitionId,
  );
  const definition = matches.length === 1 ? matches[0]! : null;
  const capabilityError = definition
    ? antennaFieldSolveDefinitionPortError(definition.port_mode_ids)
    : null;
  const authoredPorts = antennaFieldSolvePortReferences(
    (rawStage as JsonObject | undefined) ?? undefined,
  );
  const definitionPorts = definition
    ? antennaFieldSolvePortReferences(definition as unknown as JsonObject)
    : [];
  const effectivePorts = authoredPorts.length > 0 ? authoredPorts : definitionPorts;
  const selectedPorts = (sceneData?.antenna_port_modes ?? []).filter(
    (port) => port.id === effectivePorts[0],
  );
  const portsMatch = Boolean(
    definition &&
      effectivePorts.length === 1 &&
      definition.port_mode_ids.filter((id) => id === effectivePorts[0]).length === 1 &&
      selectedPorts.length === 1 &&
      selectedPorts[0]?.source_object_id === definition.source_object_id &&
      selectedPorts[0]?.current_transport_id === definition.current_transport_id,
  );
  const bound = Boolean(sceneData && definition && portsMatch && !capabilityError);
  const errorMessage = sceneData
    ? !definition || !portsMatch
      ? "The field-solve definition is missing, ambiguous, or its selected ports no longer match. Repair the antenna references before execution."
      : capabilityError
    : null;

  return {
    definitionId: definitionId ?? "missing explicit reference",
    antennaObjectId: definition?.source_object_id ?? "not bound",
    currentTransportId: definition?.current_transport_id ?? "not bound",
    portModeId: effectivePorts.join(", ") || "none",
    modelName: definition?.model ?? "not bound",
    oerstedRealization: definition?.oersted_realization ?? "not bound",
    solverPolicy: definition?.solver_policy ?? "not bound",
    declaredOutputs:
      definition?.outputs.map((o) => `${o.id}: ${o.quantity}`).join(", ") || "none",
    hasDefinition: Boolean(definition),
    bound,
    errorMessage,
  };
}

export function AntennaFieldSolveStageInspectorPanel({
  rawStagePayload,
  sceneOverride,
  selection,
}: InspectorPanelProps & {
  rawStagePayload?: Record<string, unknown>;
  sceneOverride?: SceneResource | null;
}) {
  const kernel = useContext(KernelContext);
  if (kernel && sceneOverride === undefined && !rawStagePayload) {
    return <ConnectedAntennaFieldSolveStagePanel selection={selection} />;
  }
  return (
    <AntennaFieldSolveStageInspectorPanelView
      hydratedBaseline={buildAntennaFieldSolveViewDraft(
        sceneOverride ?? null,
        rawStagePayload,
      )}
      selection={selection}
    />
  );
}

function ConnectedAntennaFieldSolveStagePanel({
  selection,
}: InspectorPanelProps) {
  const { pipelineStripSteps, sceneData, selectedStageDraft } =
    useKernelStudyAuthoring(selection);
  const hydratedBaseline = useMemo(
    () =>
      buildAntennaFieldSolveViewDraft(
        sceneData,
        selectedStageDraft?.rawStage as Record<string, unknown> | undefined,
      ),
    [sceneData, selectedStageDraft?.rawStage],
  );

  return (
    <AntennaFieldSolveStageInspectorPanelView
      hydratedBaseline={hydratedBaseline}
      pipelineStripSteps={pipelineStripSteps}
      selection={selection}
    />
  );
}

function AntennaFieldSolveStageInspectorPanelView({
  hydratedBaseline,
  pipelineStripSteps,
  selection,
}: InspectorPanelProps & {
  hydratedBaseline: AntennaFieldSolveStageDraft;
  pipelineStripSteps?: readonly PipelineStripStep[];
}) {
  const { index, stageId } = resolveStageMeta(selection, "antenna_field_solve");
  const titleLabel = `Antenna Field Solve ${index + 1}`;

  const resolvedSteps = useMemo<readonly PipelineStripStep[]>(
    () =>
      pipelineStripSteps && pipelineStripSteps.length > 0
        ? pipelineStripSteps
        : fallbackPipelineSteps(
            stageId,
            index,
            "study.stage.antenna_field_solve",
            "Antenna field solve",
          ),
    [index, pipelineStripSteps, stageId],
  );

  const spec = useMemo<InspectorSpec<AntennaFieldSolveStageDraft>>(
    () => ({
      id: "study.stage.antenna_field_solve",
      header: { breadcrumbs: stageBreadcrumbs(titleLabel) },
      identity: {
        domain: "study",
        icon: Radar,
        title: () => titleLabel,
        kindLabel: "Antenna Oersted pre-solve stage",
        entityId: stageId,
        statePill: (d) =>
          !d.hasDefinition
            ? { tone: "err", label: "Unbound" }
            : d.errorMessage
              ? { tone: "err", label: "Invalid ref" }
              : d.bound
                ? { tone: "ok", label: "Bound" }
                : { tone: "warn", label: "Unbound" },
      },
      facts: (d): readonly InspectorFact[] => [
        { id: "ant", label: "Antenna", value: d.antennaObjectId },
        { id: "port", label: "Port mode", value: d.portModeId },
        { id: "real", label: "Realization", value: d.oerstedRealization },
      ],
      notices: (d) => [
        ...(d.errorMessage
          ? [{ id: "ant-err", tone: "err" as const, text: d.errorMessage }]
          : []),
        {
          id: "ant-qualification-note",
          tone: "warn" as const,
          text: "A declared stage or output is not a solved field or physical qualification. Preparation, source ownership, and result integrity must pass before using V/J/H.",
        },
      ],
      sections: [
        {
          id: "antenna-binding",
          title: "Referenced Antenna Definition",
          icon: Radar,
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <PipelineStrip
                  currentIndex={index}
                  steps={resolvedSteps}
                  onSelectStep={(step) => {
                    if (step.selection) ctx.selectNode(step.selection);
                  }}
                />
              ),
            },
            {
              label: "Definition ID",
              type: "readonly",
              mono: true,
              format: (d) => d.definitionId,
            },
            {
              label: "Source object ID",
              type: "readonly",
              mono: true,
              format: (d) => d.antennaObjectId,
            },
            {
              label: "Current transport ID",
              type: "readonly",
              mono: true,
              format: (d) => d.currentTransportId,
            },
            {
              label: "Selected port IDs",
              type: "readonly",
              mono: true,
              format: (d) => d.portModeId,
            },
            {
              label: "Model",
              type: "readonly",
              mono: true,
              format: (d) => d.modelName,
            },
            {
              label: "Oersted realization",
              type: "readonly",
              mono: true,
              format: (d) => d.oerstedRealization,
            },
            {
              label: "Solver policy",
              type: "readonly",
              format: (d) => d.solverPolicy,
            },
            {
              label: "Declared outputs",
              type: "readonly",
              mono: true,
              format: (d) => d.declaredOutputs,
            },
            {
              label: "Parameter owner",
              type: "readonly",
              format: () =>
                "Antenna → field-solve definition / current transport / ports",
            },
          ],
        },
      ],
      commitBar: {
        mode: "readOnly",
        statusMessage: () =>
          "Edit conductor geometry and port excitation on the Antenna object node",
      },
    }),
    [index, resolvedSteps, stageId, titleLabel],
  );

  return (
    <StageSpecHost
      baseline={hydratedBaseline}
      selection={selection}
      spec={spec}
    />
  );
}

/* ── 11. study.stage.action — ActionStageFallbackInspectorPanel ──────────── */

function resolveSelectionHysteresisView(
  selection: Selection,
): HysteresisInspectorView {
  const fromNode = resolveHysteresisInspectorView(selection.nodeId);
  if (fromNode !== "overview") return fromNode;
  if (selection.ref?.type === "hysteresis-snapshot") return "snapshots";
  if (selection.ref?.type === "study-stage") {
    if (selection.ref.hysteresisExecutionNodeId) return "execution-node";
    if (selection.ref.hysteresisPointId != null) return "point-detail";
  }
  return "overview";
}

function resolveHysteresisStageIdFromSelection(
  selection: Selection,
  fallbackStageId: string,
): string {
  if (selection.ref?.type === "study-stage" && selection.ref.stageId) {
    return selection.ref.stageId;
  }
  if (selection.ref?.type === "hysteresis-snapshot" && selection.ref.stageId) {
    return selection.ref.stageId;
  }
  const match = selection.nodeId?.match(/:stage:([^:]+):/);
  return match?.[1] ?? fallbackStageId;
}

const NOOP_HYSTERESIS_KERNEL = {
  commands: {
    execute: () => Promise.resolve({ status: "completed" }),
    getSessionScopeKey: () => null,
  },
  selection: {
    clear: () => undefined,
    get: () => null,
    set: () => undefined,
    subscribe: () => () => undefined,
  },
} as unknown as KernelApi;

interface ActionFallbackDraft {
  stageId: string;
  originalKind: string;
  preservedJson: string;
}

export function ActionStageFallbackInspectorPanel({
  rawStagePayload,
  selection,
}: InspectorPanelProps & {
  rawStagePayload?: Record<string, unknown>;
}) {
  const kernel = useContext(KernelContext);
  const hysteresisView = resolveSelectionHysteresisView(selection);

  if (hysteresisView !== "overview") {
    if (kernel) {
      return (
        <ConnectedHysteresisChildInspectorPanel
          selection={selection}
          view={hysteresisView}
        />
      );
    }
    return (
      <StandaloneHysteresisChildInspectorPanel
        selection={selection}
        view={hysteresisView}
      />
    );
  }

  if (kernel && !rawStagePayload) {
    return <ConnectedActionStageFallbackPanel selection={selection} />;
  }
  return (
    <ActionStageFallbackInspectorPanelView
      rawStagePayload={rawStagePayload}
      selection={selection}
    />
  );
}

function ConnectedHysteresisChildInspectorPanel({
  selection,
  view,
}: {
  selection: Selection;
  view: Exclude<HysteresisInspectorView, "overview">;
}) {
  const kernel = useContext(KernelContext)!;
  const { selectedStageDraft } = useKernelStudyAuthoring(selection);
  const { stageId: fallbackStageId } = resolveStageMeta(selection, "hysteresis");
  const stageId = resolveHysteresisStageIdFromSelection(
    selection,
    selectedStageDraft?.stageId || fallbackStageId,
  );
  const hasSimulationApi =
    hasKernelResourceRuntime(kernel) &&
    Boolean(
      (
        kernel.api as
          | { analysis?: { hysteresis?: unknown } }
          | undefined
      )?.analysis?.hysteresis,
    );

  if (!hasSimulationApi) {
    return (
      <HysteresisChildInspectorFrame
        content={renderHysteresisSubView({
          draft: selectedStageDraft,
          kernel,
          selection,
          stageId,
          view,
        })}
        selection={selection}
        stageId={stageId}
        view={view}
      />
    );
  }

  return (
    <LoadedHysteresisChildResources
      draft={selectedStageDraft}
      kernel={kernel}
      selection={selection}
      stageId={stageId}
      view={view}
    />
  );
}

function LoadedHysteresisChildResources({
  draft,
  kernel,
  selection,
  stageId,
  view,
}: {
  draft: StudyStageDraft | null;
  kernel: KernelApi;
  selection: Selection;
  stageId: string;
  view: Exclude<HysteresisInspectorView, "overview">;
}) {
  const activePoint = activeHysteresisPointSelection(selection, stageId);

  const needPoints = [
    "point-detail",
    "live-run",
    "points",
    "points-completed",
    "points-queued",
    "points-planned",
    "snapshots",
    "transitions",
  ].includes(view);
  const needExecutionTree = [
    "execution-node",
    "points-bookmarks",
    "settle-pipeline",
  ].includes(view);
  const needBranches = view === "branches" || view === "branch-detail";
  const needProgress = [
    "current-field",
    "point-detail",
    "live-run",
    "points",
    "points-completed",
    "points-queued",
    "points-planned",
    "transitions",
  ].includes(view);
  const needOrientation = [
    "orientation",
    "point-detail",
    "points",
    "points-completed",
    "points-queued",
    "points-planned",
    "snapshots",
  ].includes(view);

  const pointsRes = useHysteresisPointsResource(stageId, { enabled: needPoints });
  const stagePlanRes = useHysteresisStagePlanResource(stageId, {
    enabled: view === "plan",
  });
  const protocolRes = useHysteresisProtocolResource(stageId, {
    enabled: view === "protocol",
  });
  const settlePipelineRes = useHysteresisSettlePipelineResource(stageId, {
    enabled: view === "settle-pipeline",
  });
  const executionTreeRes = useHysteresisExecutionTreeResource(stageId, {
    after: 1,
    before: 1,
    enabled: needExecutionTree,
  });
  const angularFamilyRes = useHysteresisFamilyResource(stageId, {
    enabled: view === "angular-family",
  });
  const metricsRes = useHysteresisMetricsResource(stageId, {
    enabled: view === "metrics" || view === "saturation",
  });
  const bookmarksRes = useHysteresisBookmarksResource(stageId, {
    enabled: view === "points-bookmarks",
  });
  const branchesRes = useHysteresisBranchesResource(stageId, {
    enabled: needBranches,
  });
  const minorLoopsRes = useHysteresisMinorLoopsResource(stageId, {
    enabled: needBranches,
  });
  const reversalFieldsRes = useHysteresisReversalFieldsResource(stageId, {
    enabled: view === "metrics",
  });
  const progressRes = useHysteresisProgressResource(stageId, {
    enabled: needProgress,
  });
  const stageSaturationRes = useHysteresisStageSaturationResource(stageId, {
    enabled: view === "saturation",
  });
  const saturationRes = useHysteresisSaturationResource(stageId, {
    enabled:
      view === "saturation" &&
      stageSaturationRes.data?.result_status === "available",
  });
  const adaptiveRefinementRes = useHysteresisAdaptiveRefinementResource(stageId, {
    enabled: view === "adaptive-refinement" || view === "plan",
  });
  const orientationRes = useHysteresisOrientationResource(stageId, {
    enabled: needOrientation,
  });
  const pointDetailRes = useHysteresisPointResource(stageId, activePoint?.pointId, {
    enabled: view === "point-detail" && activePoint?.pointId != null,
  });
  const settleTraceRes = useHysteresisSettleTraceResource(
    stageId,
    activePoint?.pointId,
    { enabled: view === "settle-trace" && activePoint?.pointId != null },
  );
  const stageSettleTraceRes = useHysteresisStageSettleTraceResource(stageId, {
    enabled: view === "settle-trace" && activePoint?.pointId == null,
  });

  const saturation =
    stageSaturationRes.data?.result ?? saturationRes.data?.saturation;
  const settleTrace =
    activePoint?.pointId != null
      ? Array.isArray(settleTraceRes.data)
        ? settleTraceRes.data
        : []
      : Array.isArray(stageSettleTraceRes.data?.settle_trace)
        ? stageSettleTraceRes.data.settle_trace
        : [];
  const settleTraceStatus =
    activePoint?.pointId != null
      ? settleTraceRes.status
      : stageSettleTraceRes.status;

  const content = renderHysteresisSubView({
    adaptiveRefinement: adaptiveRefinementRes.data?.adaptive_refinement,
    angularFamily: angularFamilyRes.data,
    bookmarks: bookmarksRes.data,
    branches: Array.isArray(branchesRes.data?.branches)
      ? branchesRes.data.branches
      : [],
    draft,
    executionTree: executionTreeRes.data,
    kernel,
    metrics: metricsRes.data?.metrics,
    minorLoops: Array.isArray(minorLoopsRes.data?.minor_loops)
      ? minorLoopsRes.data.minor_loops
      : [],
    orientation: orientationRes.data,
    pointDetail: pointDetailRes.data,
    points: Array.isArray(pointsRes.data?.points) ? pointsRes.data.points : [],
    progress: progressRes.data,
    protocol: protocolRes.data,
    reversalFields: Array.isArray(reversalFieldsRes.data?.reversal_fields)
      ? reversalFieldsRes.data.reversal_fields
      : [],
    saturation,
    settlePipeline: settlePipelineRes.data,
    settleTrace,
    settleTraceStatus,
    stageId,
    stagePlan: stagePlanRes.data,
    selection,
    view,
  });

  return (
    <HysteresisChildInspectorFrame
      content={content}
      selection={selection}
      stageId={stageId}
      view={view}
    />
  );
}

function StandaloneHysteresisChildInspectorPanel({
  selection,
  view,
}: {
  selection: Selection;
  view: Exclude<HysteresisInspectorView, "overview">;
}) {
  const { stageId: fallbackStageId } = resolveStageMeta(selection, "hysteresis");
  const stageId = resolveHysteresisStageIdFromSelection(
    selection,
    fallbackStageId,
  );
  const content = renderHysteresisSubView({
    draft: null,
    kernel: NOOP_HYSTERESIS_KERNEL,
    selection,
    stageId,
    view,
  });
  return (
    <HysteresisChildInspectorFrame
      content={content}
      selection={selection}
      stageId={stageId}
      view={view}
    />
  );
}

function renderHysteresisSubView({
  adaptiveRefinement,
  angularFamily,
  bookmarks,
  branches = [],
  draft,
  executionTree,
  kernel,
  metrics,
  minorLoops = [],
  orientation,
  pointDetail,
  points = [],
  progress,
  protocol,
  reversalFields = [],
  saturation,
  selection,
  settlePipeline,
  settleTrace = [],
  settleTraceStatus = "idle",
  stageId,
  stagePlan,
  view,
}: {
  adaptiveRefinement?: Parameters<
    typeof HysteresisAdaptiveRefinementInspector
  >[0]["adaptiveRefinement"];
  angularFamily?: Parameters<
    typeof HysteresisAngularFamilyInspector
  >[0]["angularFamily"];
  bookmarks?: Parameters<typeof HysteresisBookmarksInspector>[0]["bookmarks"];
  branches?: Parameters<typeof HysteresisBranchesInspector>[0]["branches"];
  draft: StudyStageDraft | null;
  executionTree?: Parameters<
    typeof HysteresisExecutionNodeInspector
  >[0]["executionTree"];
  kernel: KernelApi;
  metrics?: Parameters<typeof HysteresisMetricsInspector>[0]["metrics"];
  minorLoops?: Parameters<typeof HysteresisBranchesInspector>[0]["minorLoops"];
  orientation?: Parameters<
    typeof HysteresisOrientationInspector
  >[0]["orientation"];
  pointDetail?: Parameters<
    typeof HysteresisPointDetailInspector
  >[0]["pointDetail"];
  points?: Parameters<typeof HysteresisPointsInspector>[0]["points"];
  progress?: Parameters<typeof HysteresisLiveProgressInspector>[0]["progress"];
  protocol?: Parameters<typeof HysteresisProtocolInspector>[0]["protocol"];
  reversalFields?: Parameters<
    typeof HysteresisMetricsInspector
  >[0]["reversalFields"];
  saturation?: Parameters<typeof HysteresisSaturationInspector>[0]["saturation"];
  selection: Selection;
  settlePipeline?: Parameters<
    typeof HysteresisSettlePipelineInspector
  >[0]["settlePipeline"];
  settleTrace?: Parameters<
    typeof HysteresisSettleTraceInspector
  >[0]["settleTrace"];
  settleTraceStatus?: Parameters<
    typeof HysteresisSettleTraceInspector
  >[0]["settleTraceStatus"];
  stageId: string;
  stagePlan?: Parameters<typeof HysteresisPlanInspector>[0]["stagePlan"];
  view: Exclude<HysteresisInspectorView, "overview">;
}): ReactElement {
  const activeSnapshot = activeHysteresisSnapshotSelection(selection, stageId);
  const activePoint = activeHysteresisPointSelection(selection, stageId);
  const activeBranch = activeHysteresisBranchSelection(selection, stageId);
  const activeExecutionNode = activeHysteresisExecutionNodeSelection(
    selection,
    stageId,
  );
  const targetMetadata = hysteresisTargetMetadataFromOrientation(orientation);
  const saturationPoints = Array.isArray(saturation?.points)
    ? saturation.points
    : [];
  const readOnlySettleDraft = draft
    ? { ...draft, kind: "unsupported" as const }
    : null;

  switch (view) {
    case "branches":
      return (
        <HysteresisBranchesInspector
          branches={branches}
          draft={draft}
          minorLoops={minorLoops}
        />
      );
    case "branch-detail":
      return (
        <HysteresisBranchDetailInspector
          activeBranch={activeBranch}
          branches={branches}
          minorLoops={minorLoops}
        />
      );
    case "current-field":
      return <HysteresisCurrentFieldInspector progress={progress} />;
    case "adaptive-refinement":
      return (
        <HysteresisAdaptiveRefinementInspector
          adaptiveRefinement={adaptiveRefinement}
        />
      );
    case "angular-family":
      return <HysteresisAngularFamilyInspector angularFamily={angularFamily} />;
    case "execution-node":
      return (
        <HysteresisExecutionNodeInspector
          activeExecutionNode={activeExecutionNode}
          executionTree={executionTree}
        />
      );
    case "point-detail":
      return (
        <HysteresisPointDetailInspector
          activePoint={activePoint}
          kernel={kernel}
          pointDetail={pointDetail}
          points={points}
          progress={progress}
          stageId={stageId}
          targetMetadata={targetMetadata}
        />
      );
    case "live-run":
      return (
        <HysteresisLiveProgressInspector
          activeSnapshot={activeSnapshot}
          kernel={kernel}
          points={points}
          progress={progress}
          stageId={stageId}
        />
      );
    case "metrics":
      return (
        <HysteresisMetricsInspector
          metrics={metrics}
          reversalFields={reversalFields}
        />
      );
    case "plan":
      return (
        <HysteresisPlanInspector
          adaptiveRefinement={adaptiveRefinement}
          draft={draft}
          stagePlan={stagePlan}
        />
      );
    case "orientation":
      return (
        <HysteresisOrientationInspector
          draft={draft}
          orientation={orientation}
          targetMetadata={targetMetadata}
        />
      );
    case "points":
      return (
        <HysteresisPointsInspector
          activeSnapshot={activeSnapshot}
          kernel={kernel}
          points={points}
          progress={progress}
          stageId={stageId}
          targetMetadata={targetMetadata}
        />
      );
    case "points-completed":
      return (
        <HysteresisPointBucketInspector
          bucket="completed"
          kernel={kernel}
          points={points}
          progress={progress}
          stageId={stageId}
          targetMetadata={targetMetadata}
        />
      );
    case "points-queued":
      return (
        <HysteresisPointBucketInspector
          bucket="queued"
          kernel={kernel}
          points={points}
          progress={progress}
          stageId={stageId}
          targetMetadata={targetMetadata}
        />
      );
    case "points-planned":
      return (
        <HysteresisPointBucketInspector
          bucket="planned"
          kernel={kernel}
          points={points}
          progress={progress}
          stageId={stageId}
          targetMetadata={targetMetadata}
        />
      );
    case "points-bookmarks":
      return (
        <HysteresisBookmarksInspector
          bookmarks={bookmarks}
          executionTree={executionTree}
        />
      );
    case "protocol":
      return (
        <HysteresisProtocolInspector draft={draft} protocol={protocol} />
      );
    case "saturation":
      return (
        <HysteresisSaturationInspector
          draft={draft}
          metrics={metrics}
          saturation={saturation}
          saturationPoints={saturationPoints}
        />
      );
    case "settle-pipeline":
      return (
        <HysteresisSettlePipelineInspector
          draft={readOnlySettleDraft}
          executionTree={executionTree}
          onUpdateDraft={() => undefined}
          settlePipeline={settlePipeline}
        />
      );
    case "snapshots":
      return (
        <HysteresisSnapshotsInspector
          activeSnapshot={activeSnapshot}
          draft={draft}
          kernel={kernel}
          points={points}
          stageId={stageId}
          targetMetadata={targetMetadata}
        />
      );
    case "settle-trace":
      return (
        <HysteresisSettleTraceInspector
          activePoint={activePoint}
          settleTrace={settleTrace}
          settleTraceStatus={settleTraceStatus}
        />
      );
    case "transitions":
      return (
        <HysteresisTransitionsInspector
          activePoint={activePoint}
          kernel={kernel}
          points={points}
          progress={progress}
          stageId={stageId}
        />
      );
  }
}

function HysteresisChildInspectorFrame({
  content,
  selection,
  stageId,
  view,
}: {
  content: ReactElement;
  selection: Selection;
  stageId: string;
  view: Exclude<HysteresisInspectorView, "overview">;
}) {
  const titleLabel = selection.label ?? `Hysteresis (${view})`;
  const baseline = useMemo(() => ({ stageId, view }), [stageId, view]);
  const spec = useMemo<InspectorSpec<{ stageId: string; view: string }>>(
    () => ({
      id: "study.stage.action.hysteresis",
      header: { breadcrumbs: stageBreadcrumbs(titleLabel) },
      identity: {
        domain: "study",
        icon: Magnet,
        title: () => titleLabel,
        kindLabel: `Hysteresis ${view.replace(/-/g, " ")} detail`,
        entityId: stageId,
        statePill: () => ({ tone: "info", label: "Read-only" }),
      },
      facts: (d): readonly InspectorFact[] => [
        { id: "stage", label: "Stage ID", value: d.stageId },
        { id: "view", label: "Sub-panel", value: d.view.replace(/-/g, " ") },
      ],
      sections: [
        {
          id: "hysteresis-detail",
          title: "Hysteresis Execution Detail",
          icon: Magnet,
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              wide: true,
              render: () => content,
            },
          ],
        },
      ],
      commitBar: {
        mode: "readOnly",
        statusMessage: () =>
          "Edit hysteresis loop parameters on the parent Hysteresis stage node",
      },
    }),
    [content, stageId, titleLabel, view],
  );

  return <StageSpecHost baseline={baseline} selection={selection} spec={spec} />;
}

function ConnectedActionStageFallbackPanel({ selection }: InspectorPanelProps) {
  const { selectedStageDraft } = useKernelStudyAuthoring(selection);
  const { stageId: fallbackId } = resolveStageMeta(selection, "action");
  const stageId = selectedStageDraft?.stageId || fallbackId;
  const raw = selectedStageDraft?.rawStage as Record<string, unknown> | undefined;
  const originalKind =
    typeof raw?.kind === "string" && raw.kind.trim()
      ? raw.kind
      : selectedStageDraft?.kind && selectedStageDraft.kind !== "unsupported"
        ? selectedStageDraft.kind
        : "not declared";
  const hydratedBaseline = useMemo<ActionFallbackDraft>(
    () => ({
      stageId,
      originalKind,
      preservedJson: JSON.stringify(
        raw ?? {
          stage_id: stageId,
          kind: originalKind === "not declared" ? "pipeline_instruction" : originalKind,
        },
        null,
        2,
      ),
    }),
    [originalKind, raw, stageId],
  );
  return (
    <ActionStageFallbackInspectorPanelView
      hydratedBaseline={hydratedBaseline}
      selection={selection}
    />
  );
}

function ActionStageFallbackInspectorPanelView({
  hydratedBaseline,
  rawStagePayload,
  selection,
}: InspectorPanelProps & {
  hydratedBaseline?: ActionFallbackDraft;
  rawStagePayload?: Record<string, unknown>;
}) {
  const { index, stageId } = resolveStageMeta(selection, "action");
  const titleLabel = selection.label ?? `Pipeline Action ${index + 1}`;
  const rawKind =
    typeof rawStagePayload?.kind === "string" && rawStagePayload.kind.trim()
      ? rawStagePayload.kind
      : "not declared";

  const fallbackBaseline = useMemo<ActionFallbackDraft>(
    () => ({
      stageId,
      originalKind: rawKind,
      preservedJson: JSON.stringify(
        rawStagePayload ?? { stage_id: stageId, kind: "pipeline_instruction" },
        null,
        2,
      ),
    }),
    [rawKind, rawStagePayload, stageId],
  );
  const baseline = hydratedBaseline ?? fallbackBaseline;

  const spec = useMemo<InspectorSpec<ActionFallbackDraft>>(
    () => ({
      id: "study.stage.action",
      header: { breadcrumbs: stageBreadcrumbs(titleLabel) },
      identity: {
        domain: "study",
        icon: Info,
        title: () => titleLabel,
        kindLabel: "Preserved pipeline instruction",
        entityId: stageId,
        statePill: () => ({ tone: "info", label: "Preserved" }),
      },
      facts: (d): readonly InspectorFact[] => [
        { id: "id", label: "Stage ID", value: d.stageId },
        { id: "kind", label: "Original kind", value: d.originalKind },
        { id: "mode", label: "Authoring", value: "Lossless read-only" },
      ],
      notices: () => [
        {
          id: "preserved-info",
          tone: "warn",
          text: "This stage kind is not editable in the current inspector. Fullmag preserves its original payload losslessly and will not reinterpret it as another physical instruction.",
        },
      ],
      sections: [
        {
          id: "unsupported-meta",
          title: "Unsupported Stage",
          icon: Info,
          defaultOpen: true,
          rows: [
            {
              label: "Original kind",
              type: "readonly",
              mono: true,
              format: (d) => d.originalKind,
            },
            {
              label: "Editing",
              type: "readonly",
              format: () => "Disabled to prevent semantic drift",
            },
            {
              label: "Round-trip",
              type: "readonly",
              format: () => "Original payload preserved",
            },
          ],
        },
        {
          id: "preserved-payload",
          title: "Preserved payload",
          icon: Database,
          defaultOpen: false,
          rows: [
            {
              label: "IR payload",
              type: "readonly",
              mono: true,
              format: (d) => d.preservedJson,
            },
          ],
        },
      ],
      commitBar: {
        mode: "readOnly",
        statusMessage: () => "Preserved pipeline instruction",
      },
    }),
    [stageId, titleLabel],
  );

  return <StageSpecHost baseline={baseline} selection={selection} spec={spec} />;
}
