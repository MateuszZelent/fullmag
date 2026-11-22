"use client";

import {
  Activity,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Copy,
  Cpu,
  Database,
  Download,
  FileOutput,
  Gauge,
  GripVertical,
  History,
  Info,
  Layers,
  Magnet,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Scissors,
  Sigma,
  SkipForward,
  Sliders,
  Square,
  Timer,
  Trash2,
  Upload,
  Workflow,
} from "lucide-react";
import { useCallback, useContext, useEffect, useMemo, useState } from "react";

import {
  MODEL_READINESS_PATH,
  MODEL_SCENE_PATH,
  PERSISTENCE_CHECKPOINTS_PATH,
  SIMULATION_COMMANDS_PATH,
} from "@/kernel/api/apiPaths";
import type {
  CheckpointEntry,
  SceneResource,
  SessionImportInspectResponse,
  SolverStatusResource,
} from "@/kernel/api/apiTypes";
import { runFdmGridRefreshOperation } from "@/kernel/authoring/geometryLifecycleCommandContributions";
import { KernelContext } from "@/kernel/KernelContext";
import {
  useCommandDetailResource,
  useModelReadinessResource,
} from "@/kernel/resources/studyRuntimeResources";
import type { ActiveLaneCapabilitySnapshot } from "@/kernel/resources/useActiveLaneCapabilities";
import { useExecutionProfilesResource } from "@/kernel/resources/useExecutionProfilesResource";
import type { Selection } from "@/kernel/selection/selectionTypes";
import { CommandDetailDialog } from "@/shared/runtime/CommandDetailDialog";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/ui/DropdownMenu";
import { EmptyState } from "@/shared/ui/EmptyState";
import { Input } from "@/shared/ui/Input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/Select";
import { Switch } from "@/shared/ui/Switch";

import type { InspectorPanelProps } from "../../inspectorTypes";
import type { InspectorFact, InspectorNotice, InspectorSpec } from "../../template";
import { ProjectBatchesSection } from "../ProjectBatchesSection";
import { ProjectRunsSection } from "../ProjectRunsSection";
import {
  buildStudyExecutionProfileAssignment,
  createStudyExecutionProfileDraft,
  hasChangeDeviceStudyStage,
  hasStudyExecutionProfile,
  sameStudyExecutionProfile,
  selectStudyExecutionProfile,
  studyExecutionProfileDraftIsDirty,
  studyExecutionProfileKey,
  updateStudyExecutionProfileOverride,
  validateStudyExecutionProfileDraft,
  type StudyExecutionProfileAssignment,
  type StudyExecutionProfileDraft,
  type StudyExecutionProfileOverrideKey,
} from "../StudyExecutionProfileModel";
import {
  isExplicitFdmStudy,
  normalizeDemagRealizationForLane,
  resolveFdmGridPreview,
  type StudyGlobalDraft,
} from "../StudyGlobalAuthoringModel";
import {
  ImportStateDialog,
  RestoreCheckpointDialog,
} from "../StudyInspectorDialogs";
import { readFileAsBase64 } from "../StudyInspectorDialogs.model";
import type { StudyInspectorModel } from "../StudyInspectorPanelModel";
import { StudyProgressBar } from "../StudyProgressBar";
import {
  createDefaultStudyStageDraft,
  type StudyStageDraft,
  type StudyStageDraftKind,
} from "../StudyStageAuthoringModel";
import { formatGridVector } from "../studyInspectorShared";
import {
  resolveStudyWorkflowStateBefore,
  validateStudyWorkflow,
} from "../stages/studyWorkflowState";
import {
  ConnectedInspectorSpec,
  ENERGY_JOULE_UNITS_SI,
  FIELD_TESLA_UNITS_SI,
  LENGTH_UNITS_SI,
  MEMORY_BYTES_UNITS_SI,
  PipelineStrip,
  TIME_UNITS_SI,
  TORQUE_APM_UNITS_SI,
  type PipelineStripStep,
} from "./ConnectedInspectorSpec";
import {
  buildStudyCommandContext,
  useKernelStudyAuthoring,
  useKernelStudyRecoveryResources,
  useKernelStudyRuntimeTelemetry,
} from "./useConnectedStudyAuthoring";

export interface StudyExecutionTestSnapshot {
  requestedDevice?: "auto" | "gpu" | "cpu";
  discretization?: "auto" | "fdm" | "fem" | "hybrid";
  sessionDiscretization?: "fdm" | "fem" | null;
  precision?: "double" | "single";
  qualificationMode?: "strict" | "extended" | "hybrid";
  cudaAvailable?: boolean;
  resolvedDeviceLabel?: string;
  magneticObjectCount?: number;
}

interface StudyRootDraft {
  name: string;
  executionTrigger: "wait_for_compute" | "auto_run";
  computeScope: "full_study" | "up_to_stage" | "from_checkpoint";
  targetEndStageId: string;
  isRunning: boolean;
  preflightErrorCount: number;
  activeStageCount: number;
  skippedStageCount: number;
  magnetCount: number;
  laneSummary: string;
  lastRunLabel: string | null;
  sceneRevision: number;
  pipelineSteps: readonly PipelineStripStep[];
}

interface StudyExecutionDraft {
  executionProfile: string;
  discretization: "auto" | "fdm" | "fem" | "hybrid";
  requestedDevice: "auto" | "gpu" | "cpu";
  precision: "double" | "single";
  qualificationMode: "strict" | "extended" | "hybrid";
  cpuThreadsText: string;
  parallelMode: "serial" | "adaptive";
  maxWorkers: number;
  threadsPerWorker: number;
  maxCpuPercent: number;
  maxMemoryPercent: number;
  memoryReserveBytes: number;
  exchangeEnabled: boolean;
  demagEnabled: boolean;
  fdmDemagStrategy: "auto" | "single_grid" | "multilayer_convolution";
  fdmDemagMode: "auto" | "two_d_stack" | "three_d";
  fdmDefaultCell: string;
  fdmPerMagnet: string;
  fdmCommonCells: string;
  fdmCommonCellsXy: string;
  fdmDemagExplain: boolean;
  fdmBoundaryCorrection: string;
  boundaryPhiFloor: number;
  boundaryDeltaMinM: number;
  femDemagSolver:
    | "auto"
    | "poisson_robin"
    | "poisson_dirichlet"
    | "fredkin_koehler"
    | "bem"
    | "fmm"
    | "airbox_robin";
  femDemagPolicyJson: string;
  externalFieldTesla: readonly [number, number, number];
  defaultIntegrator: string;
  defaultTimestepMode: "auto" | "adaptive_max_error" | "adaptive_advanced" | "fixed";
  defaultFixedDtS: number;
  defaultDtInitS: number;
  defaultDtMinS: number;
  defaultDtMaxS: number;
  defaultMaxErr: number;
  defaultAtol: number;
  defaultRtol: number;
  defaultSafety: number;
  defaultGrowthLimit: number;
  defaultShrinkLimit: number;
  defaultMaxSpinRotation: string;
  defaultNormTolerance: string;
  defaultDemagIntervalS: number;
  defaultRelaxAlgorithm: string;
  defaultTorqueToleranceApm: number;
  defaultEnergyToleranceJ: number;
  defaultMaxRelaxSteps: number;
  advancedSolverJson: string;
  cudaAvailable: boolean;
  gpuName: string | null;
  cpuThreadCap: number;
  magneticObjectCount: number;
  hasChangeDeviceStage: boolean;
  executionProfileBound: boolean;
  requestedDiscretization: string | null;
  sessionDiscretization: string | null;
}

function isExplicitFdmDraft(draft: StudyExecutionDraft): boolean {
  return isExplicitFdmStudy({
    requestedBackend: draft.executionProfileBound ? null : draft.discretization,
    requestedDiscretization: draft.requestedDiscretization,
    sessionDiscretization: draft.sessionDiscretization,
  });
}

interface StudyStageSequenceItem {
  readonly rowKey: string;
  readonly stageId: string;
  readonly kind: string;
  readonly label: string;
  readonly summary: string;
  readonly durationBadge: string;
  readonly enabled: boolean;
}

interface StudyStagesDraft {
  stagesJson: string;
  totalCount: number;
  enabledCount: number;
  computeCount: number;
  zeroDurationCount: number;
}

interface StudyCheckpointItem {
  readonly id: string;
  readonly stepLabel: string;
  readonly resumeClass: string;
  readonly sourceLabel: string | null;
  readonly stageId: string | null;
}

interface StudyRecoveryDraft {
  checkpoints: readonly StudyCheckpointItem[];
  latestStep: string | null;
  resumeClass: string | null;
  energyRows: number;
  totalEnergyRows: number;
  totalEnergyJ: number | null;
  zeemanEnergyJ: number | null;
  latestDeDt: string | null;
  latestRhsNorm: string | null;
  hasPausedState: boolean;
  importFormat: "fms" | "ovf" | "npz";
  exportFormat: "ovf" | "zarr" | "fms";
}

const DEFAULT_PIPELINE_STEPS: readonly PipelineStripStep[] = [
  {
    id: "relax_1",
    index: 0,
    kind: "study.stage.relax",
    label: "Relax",
    status: "completed",
    selection: {
      kind: "study.stage.relax",
      label: "Relax 1",
      nodeId: "model:study:stages:stage:relax_1",
      objectId: null,
      ref: {
        kind: "study.stage.relax",
        nodeId: "model:study:stages:stage:relax_1",
        stageId: "relax_1",
        stageIndex: 0,
        type: "study-stage",
      },
    },
  },
  {
    id: "k0_sinc",
    index: 1,
    kind: "study.stage.add_field_drive",
    label: "Add Field Drive",
    status: "ready",
    selection: {
      kind: "study.stage.add_field_drive",
      label: "Add Field Drive 2",
      nodeId: "model:study:stages:stage:k0_sinc",
      objectId: null,
      ref: {
        kind: "study.stage.add_field_drive",
        nodeId: "model:study:stages:stage:k0_sinc",
        stageId: "k0_sinc",
        stageIndex: 1,
        type: "study-stage",
      },
    },
  },
  {
    id: "tbl_clock",
    index: 2,
    kind: "study.stage.table_autosave",
    label: "Table Autosave",
    status: "ready",
    selection: {
      kind: "study.stage.table_autosave",
      label: "Table Autosave 3",
      nodeId: "model:study:stages:stage:tbl_clock",
      objectId: null,
      ref: {
        kind: "study.stage.table_autosave",
        nodeId: "model:study:stages:stage:tbl_clock",
        stageId: "tbl_clock",
        stageIndex: 2,
        type: "study-stage",
      },
    },
  },
  {
    id: "run_main",
    index: 3,
    kind: "study.stage.run",
    label: "Run",
    status: "ready",
    selection: {
      kind: "study.stage.run",
      label: "Run 4",
      nodeId: "model:study:stages:stage:run_main",
      objectId: null,
      ref: {
        kind: "study.stage.run",
        nodeId: "model:study:stages:stage:run_main",
        stageId: "run_main",
        stageIndex: 3,
        type: "study-stage",
      },
    },
  },
];

function studyBreadcrumbs(leafLabel?: string): readonly {
  id: string;
  label: string;
  selection?: Omit<Selection, "moduleSource">;
}[] {
  const rootCrumb = {
    id: "study-root",
    label: "Study",
    selection: {
      kind: "study.root",
      label: "Study",
      nodeId: "model:study",
      objectId: null,
      ref: { kind: "study.root" as const, nodeId: "model:study", type: "study" as const },
    },
  };
  if (!leafLabel) return [{ id: "study-root", label: "Study" }];
  return [rootCrumb, { id: `study-${leafLabel.toLowerCase()}`, label: leafLabel }];
}

function resolveEffectiveDeviceDisplay(draft: StudyExecutionDraft): {
  factValue: string;
  readoutValue: string;
  blockedGpu: boolean;
} {
  if (draft.requestedDevice === "gpu") {
    if (!draft.cudaAvailable) {
      return {
        factValue: "GPU (Blocked)",
        readoutValue: "Blocked — CUDA device missing on active host",
        blockedGpu: true,
      };
    }
    const gpuLabel = draft.gpuName ?? "CUDA GPU";
    return {
      factValue: `GPU (${gpuLabel})`,
      readoutValue: `${gpuLabel} · Strict GPU (no CPU fallback)`,
      blockedGpu: false,
    };
  }
  if (draft.requestedDevice === "cpu") {
    const parsedThreads = Number(draft.cpuThreadsText.trim());
    const effectiveThreads =
      Number.isFinite(parsedThreads) && parsedThreads > 0
        ? parsedThreads
        : draft.cpuThreadCap;
    return {
      factValue: `CPU (${effectiveThreads} threads)`,
      readoutValue: `CPU · ${draft.cpuThreadsText.trim() ? `${effectiveThreads} threads` : `Auto (${draft.cpuThreadCap} host threads)`}`,
      blockedGpu: false,
    };
  }
  if (draft.cudaAvailable) {
    const gpuLabel = draft.gpuName ?? "CUDA GPU";
    return {
      factValue: "Auto → GPU",
      readoutValue: `Auto → GPU (${gpuLabel})`,
      blockedGpu: false,
    };
  }
  return {
    factValue: "Auto → CPU",
    readoutValue: `Auto → CPU (${draft.cpuThreadCap} threads · no CUDA device)`,
    blockedGpu: false,
  };
}

/* ── 1. study.root — StudyRootInspectorPanel ────────────────────────────── */

function hasSubscribableResourceStore(kernel: unknown): boolean {
  return (
    typeof (
      kernel as { resources?: { subscribe?: unknown } } | null | undefined
    )?.resources?.subscribe === "function"
  );
}

function ConnectedReadinessBridge({
  onReadiness,
}: {
  onReadiness: (data: Record<string, unknown> | null) => void;
}) {
  const readiness = useModelReadinessResource();
  useEffect(() => {
    onReadiness((readiness.data ?? null) as Record<string, unknown> | null);
  }, [onReadiness, readiness.data]);
  return null;
}

export function StudyRootInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  if (kernel) {
    return <ConnectedStudyRootInspectorPanel selection={selection} />;
  }
  return (
    <StudyRootInspectorPanelView
      runtimeModel={null}
      sceneData={null}
      selection={selection}
    />
  );
}

function cleanProvenanceToken(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed === "not loaded" ||
    trimmed === "not available" ||
    trimmed === "unresolved" ||
    trimmed === "unavailable"
  ) {
    return null;
  }
  return trimmed;
}

function ConnectedStudyRootInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  const {
    commitStudyMetadata,
    executeSelectedStage,
    executeStudyCommand,
    lastAuthoringError,
    pipelineStripSteps,
    runtimeStatus,
    sceneData,
    stageDrafts,
  } = useKernelStudyAuthoring(selection);
  const { model, solverStatus } = useKernelStudyRuntimeTelemetry(selection);
  const [readinessData, setReadinessData] = useState<Record<string, unknown> | null>(
    null,
  );
  const canSubscribeResources = hasSubscribableResourceStore(kernel);

  return (
    <>
      {canSubscribeResources ? (
        <ConnectedReadinessBridge onReadiness={setReadinessData} />
      ) : null}
      <StudyRootInspectorPanelView
        activeLane={runtimeStatus?.capabilities?.active_lane ?? null}
        commitStudyMetadata={commitStudyMetadata}
        executeSelectedStage={executeSelectedStage}
        executeStudyCommand={executeStudyCommand}
        lastAuthoringError={lastAuthoringError}
        pipelineStripSteps={pipelineStripSteps}
        readinessData={readinessData}
        runtimeModel={model}
        sceneData={sceneData as unknown as Record<string, unknown> | null}
        selection={selection}
        solverStatus={solverStatus}
        stageDrafts={stageDrafts}
      />
    </>
  );
}

function StudyRootInspectorPanelView({
  activeLane = null,
  commitStudyMetadata,
  executeSelectedStage,
  executeStudyCommand,
  lastAuthoringError = null,
  pipelineStripSteps,
  readinessData = null,
  runtimeModel,
  sceneData,
  selection,
  solverStatus = null,
  stageDrafts,
}: InspectorPanelProps & {
  activeLane?: ActiveLaneCapabilitySnapshot | null;
  commitStudyMetadata?: (studyPatch: Record<string, unknown>) => Promise<boolean>;
  executeSelectedStage?: (stageId: string) => Promise<void>;
  executeStudyCommand?: (commandId: string, input?: Record<string, unknown>) => Promise<void>;
  lastAuthoringError?: string | null;
  pipelineStripSteps?: readonly PipelineStripStep[];
  readinessData?: Record<string, unknown> | null;
  runtimeModel: StudyInspectorModel | null;
  sceneData: Record<string, unknown> | null;
  solverStatus?: SolverStatusResource | null;
  stageDrafts?: readonly StudyStageDraft[];
}) {
  const kernel = useContext(KernelContext);
  const canSubscribeResources = hasSubscribableResourceStore(kernel);
  const [selectedCommandId, setSelectedCommandId] = useState<string | null>(null);

  const peekedData = (
    kernel?.resources as unknown as
      | { peek?: (key: string) => { data?: Record<string, unknown> | null } | undefined }
      | undefined
  )?.peek?.(MODEL_SCENE_PATH)?.data ?? null;
  const peekedReadiness = (
    kernel?.resources as unknown as
      | { peek?: (key: string) => { data?: Record<string, unknown> | null } | undefined }
      | undefined
  )?.peek?.(MODEL_READINESS_PATH)?.data ?? null;
  const activeSceneData = sceneData ?? peekedData;
  const activeReadiness = readinessData ?? peekedReadiness;
  const sceneStudy = (activeSceneData?.study ?? null) as Record<string, unknown> | null;
  const rawStages = Array.isArray(sceneStudy?.stages) ? sceneStudy.stages : null;

  const preflightBlockers = useMemo<readonly string[]>(() => {
    if (!activeReadiness) return [];
    const out: string[] = [];
    if (Array.isArray(activeReadiness.blockers)) {
      for (const b of activeReadiness.blockers) {
        if (typeof b === "string") out.push(b);
        else if (
          b &&
          typeof b === "object" &&
          typeof (b as { message?: unknown }).message === "string"
        ) {
          out.push((b as { message: string }).message);
        }
      }
    }
    if (Array.isArray(activeReadiness.issues)) {
      for (const issue of activeReadiness.issues) {
        if (
          issue &&
          typeof issue === "object" &&
          (issue as { severity?: unknown }).severity === "error" &&
          typeof (issue as { message?: unknown }).message === "string"
        ) {
          out.push((issue as { message: string }).message);
        }
      }
    }
    return out;
  }, [activeReadiness]);

  const isRunning = useMemo(() => {
    const state = runtimeModel?.runtime.state?.toLowerCase() ?? "";
    return state === "running" || state === "queued" || state === "preparing";
  }, [runtimeModel?.runtime.state]);

  const baseline = useMemo<StudyRootDraft>(() => {
    const steps: PipelineStripStep[] =
      pipelineStripSteps !== undefined
        ? [...pipelineStripSteps]
        : rawStages
          ? rawStages.map((raw, idx) => {
              const item = (raw ?? {}) as Record<string, unknown>;
              const kindStr = String(item.kind ?? "relax").toLowerCase();
              const stageId = String(item.stage_id ?? item.id ?? `stage_${idx + 1}`);
              const routeKind = `study.stage.${kindStr}`;
              return {
                id: stageId,
                index: idx,
                kind: routeKind,
                label: kindStr.replace(/_/g, " "),
                status: "ready" as const,
                selection: {
                  kind: routeKind,
                  label: `${kindStr} ${idx + 1}`,
                  nodeId: `model:study:stages:stage:${stageId}`,
                  objectId: null,
                  ref: {
                    kind: "study.stage.action" as const,
                    nodeId: `model:study:stages:stage:${stageId}`,
                    stageId,
                    stageIndex: idx,
                    type: "study-stage" as const,
                  },
                },
              };
            })
          : [...DEFAULT_PIPELINE_STEPS];

    const skippedCount = stageDrafts
      ? stageDrafts.filter(
          (d) => d.stageEnabled === false || d.pipelineEnabled === false,
        ).length
      : 0;
    const activeCount = Math.max(0, steps.length - skippedCount);

    const rawObjects = Array.isArray(activeSceneData?.objects)
      ? (activeSceneData.objects as Array<Record<string, unknown>>)
      : null;
    const magnetCount = rawObjects
      ? rawObjects.filter((obj) => !obj.role || obj.role === "magnet").length
      : 1;

    const rawTrigger = sceneStudy?.execution_trigger;
    const executionTrigger: StudyRootDraft["executionTrigger"] =
      rawTrigger === "auto_run" ? "auto_run" : "wait_for_compute";

    let laneSummary = "FDM · Auto → GPU (FP64)";
    if (runtimeModel) {
      const prov = runtimeModel.runtime.runtimeProvenance;
      const backend =
        cleanProvenanceToken(prov?.resolved.backend) ??
        cleanProvenanceToken(
          activeLane?.resolved?.backend ?? activeLane?.resolved?.discretization,
        ) ??
        cleanProvenanceToken(activeLane?.requested?.backend) ??
        cleanProvenanceToken(runtimeModel.requested.backend) ??
        "auto";
      const device =
        cleanProvenanceToken(prov?.resolved.device) ??
        cleanProvenanceToken(activeLane?.resolved?.device) ??
        cleanProvenanceToken(activeLane?.requested?.device) ??
        cleanProvenanceToken(runtimeModel.requested.device) ??
        "auto";
      const precision =
        cleanProvenanceToken(prov?.resolved.precision) ??
        cleanProvenanceToken(activeLane?.resolved?.precision) ??
        cleanProvenanceToken(activeLane?.requested?.precision) ??
        cleanProvenanceToken(runtimeModel.requested.precision) ??
        "double";
      laneSummary = `${backend} · ${device} (${precision})`;
    }

    return {
      name:
        typeof sceneStudy?.name === "string" && sceneStudy.name.trim()
          ? sceneStudy.name
          : "Main study",
      executionTrigger,
      computeScope: "full_study",
      targetEndStageId: steps.at(-1)?.id ?? "run_main",
      isRunning,
      preflightErrorCount: preflightBlockers.length,
      activeStageCount: activeCount,
      skippedStageCount: skippedCount,
      magnetCount,
      laneSummary,
      lastRunLabel:
        runtimeModel?.runtime.runId && runtimeModel.runtime.runId !== "none"
          ? runtimeModel.runtime.runId
          : null,
      sceneRevision:
        typeof activeSceneData?.revision === "number"
          ? activeSceneData.revision
          : 1,
      pipelineSteps: steps,
    };
  }, [
    activeLane,
    activeSceneData,
    isRunning,
    pipelineStripSteps,
    preflightBlockers.length,
    rawStages,
    runtimeModel,
    sceneStudy,
    stageDrafts,
  ]);

  const executeKernelCommand = useCallback(
    async (
      commandId: string,
      fallbackMessage: string,
      notify: (msg: string) => void,
      input?: Record<string, unknown>,
    ) => {
      if (executeStudyCommand) {
        await executeStudyCommand(commandId, input);
        return;
      }
      if (kernel) {
        await kernel.commands.execute(
          commandId,
          buildStudyCommandContext(kernel, {
            sceneData: activeSceneData,
            sourceDetail: "study.root",
          }),
          input,
        );
      } else {
        notify(fallbackMessage);
      }
    },
    [activeSceneData, executeStudyCommand, kernel],
  );

  const runScopedStudyCompute = useCallback(
    async (draft: StudyRootDraft, notify: (msg: string, detail?: string) => void) => {
      if (!kernel) {
        notify(
          draft.isRunning ? "Study stop requested" : "Study compute requested",
          SIMULATION_COMMANDS_PATH,
        );
        return;
      }
      if (draft.isRunning) {
        await executeKernelCommand("study.stop", "Stop requested", notify);
        return;
      }
      if (draft.computeScope === "up_to_stage" && draft.targetEndStageId) {
        if (executeSelectedStage) {
          await executeSelectedStage(draft.targetEndStageId);
          return;
        }
        const targetStep = draft.pipelineSteps.find(
          (step) => step.id === draft.targetEndStageId,
        );
        if (
          targetStep?.kind === "study.stage.run" ||
          targetStep?.kind === "study.stage.relax"
        ) {
          await executeKernelCommand(
            "study.execute-stage",
            "Stage compute requested",
            notify,
            {
              initialState: { kind: "default_for_target" },
              stageId: draft.targetEndStageId,
            },
          );
        } else {
          await executeKernelCommand("study.run", "Compute queued", notify);
        }
        return;
      }
      if (draft.computeScope === "from_checkpoint") {
        await executeKernelCommand("study.resume", "Resume requested", notify);
        return;
      }
      await executeKernelCommand("study.run", "Compute queued", notify);
    },
    [executeKernelCommand, executeSelectedStage, kernel],
  );

  const spec = useMemo<InspectorSpec<StudyRootDraft>>(
    () => ({
      id: "study.root",
      header: {
        breadcrumbs: studyBreadcrumbs(),
        canFitView: true,
        primaryHeaderAction: {
          label: baseline.isRunning ? "Stop Study" : "Compute Study",
          icon: baseline.isRunning ? Square : Play,
          variant: baseline.isRunning ? "destructive" : "secondary",
          ...(baseline.isRunning
            ? {
                confirm: {
                  title: "Stop active study run?",
                  description:
                    "Stopping halts the solver at the next step boundary while keeping completed stage outputs.",
                  confirmLabel: "Stop Study",
                },
              }
            : {}),
          onRun: async (ctx) => {
            await runScopedStudyCompute(ctx.draft, ctx.notify);
          },
        },
      },
      identity: {
        domain: "study",
        icon: Workflow,
        title: (draft) => draft.name,
        renameFieldKey: "name",
        kindLabel: "Study workflow",
        entityId: "study:main",
        statePill: (draft) => {
          if (draft.isRunning) return { tone: "live", label: "Running" };
          if (draft.preflightErrorCount > 0) {
            return { tone: "err", label: `${draft.preflightErrorCount} issues` };
          }
          return { tone: "ok", label: "Ready" };
        },
      },
      facts: (draft): readonly InspectorFact[] => [
        { id: "lane", label: "Lane", value: draft.laneSummary, tone: "info" },
        {
          id: "stages",
          label: "Stages",
          value:
            draft.skippedStageCount > 0
              ? `${draft.activeStageCount} active (${draft.skippedStageCount} skipped)`
              : `${draft.activeStageCount} active`,
        },
        {
          id: "objects",
          label: "Objects",
          value: `${draft.magnetCount} ${draft.magnetCount === 1 ? "magnet" : "magnets"}`,
        },
        { id: "lastRun", label: "Last run", value: draft.lastRunLabel },
      ],
      notices: (): readonly InspectorNotice<StudyRootDraft>[] => {
        const list: InspectorNotice<StudyRootDraft>[] = preflightBlockers.map(
          (msg, idx) => ({
            id: `preflight-${idx}`,
            tone: "err",
            text: msg,
          }),
        );
        if (lastAuthoringError) {
          list.unshift({
            id: "study-root-err",
            tone: "err",
            text: lastAuthoringError,
          });
        }
        return list;
      },
      sections: [
        {
          id: "run-control",
          title: "Run control",
          icon: Play,
          defaultOpen: true,
          summary: (d) =>
            d.executionTrigger === "auto_run" ? "Auto-run on Apply" : "Wait for Compute",
          rows: [
            {
              key: "executionTrigger",
              label: "Execution trigger",
              type: "segmented",
              options: [
                { value: "wait_for_compute", label: "Wait for Compute" },
                { value: "auto_run", label: "Auto-run on Apply" },
              ],
            },
            {
              key: "computeScope",
              label: "Compute scope",
              type: "select",
              structural: true,
              options: [
                { value: "full_study", label: "All enabled stages" },
                { value: "up_to_stage", label: "Up to stage…" },
                { value: "from_checkpoint", label: "Resume from latest checkpoint" },
              ],
            },
            {
              key: "targetEndStageId",
              label: "Target end stage",
              type: "select",
              showWhen: (d) => d.computeScope === "up_to_stage",
              options: baseline.pipelineSteps.map((step) => ({
                value: step.id,
                label: `${step.index + 1}. ${step.label} (${step.id})`,
              })),
            },
            {
              label: "Solver lifecycle",
              type: "custom",
              wide: true,
              render: (ctx) => (
                <div className="flex flex-wrap gap-1.5">
                  <Button
                    size="sm"
                    type="button"
                    variant="primary"
                    onClick={() =>
                      void runScopedStudyCompute(ctx.draft, ctx.notify)
                    }
                  >
                    <Play aria-hidden="true" size={13} />
                    <span>Compute</span>
                  </Button>
                  <Button
                    size="sm"
                    type="button"
                    variant="secondary"
                    onClick={() =>
                      void executeKernelCommand(
                        "study.build-and-run",
                        "Build + Study queued",
                        ctx.notify,
                      )
                    }
                  >
                    <Play aria-hidden="true" size={13} />
                    <span>Build + Study</span>
                  </Button>
                  <Button
                    size="sm"
                    type="button"
                    variant="ghost"
                    onClick={() =>
                      void executeKernelCommand(
                        "study.cancel-build-and-run",
                        "Cancel Build + Study requested",
                        ctx.notify,
                      )
                    }
                  >
                    <Square aria-hidden="true" size={13} />
                    <span>Cancel Build + Study</span>
                  </Button>
                  <Button
                    size="sm"
                    type="button"
                    variant="ghost"
                    onClick={() =>
                      void executeKernelCommand(
                        "study.pause",
                        "Pause requested",
                        ctx.notify,
                      )
                    }
                  >
                    <Pause aria-hidden="true" size={13} />
                    <span>Pause</span>
                  </Button>
                  <Button
                    size="sm"
                    type="button"
                    variant="ghost"
                    onClick={() =>
                      void executeKernelCommand(
                        "study.resume",
                        "Resume requested",
                        ctx.notify,
                      )
                    }
                  >
                    <Play aria-hidden="true" size={13} />
                    <span>Resume</span>
                  </Button>
                  <Button
                    size="sm"
                    type="button"
                    variant="ghost"
                    onClick={() =>
                      void executeKernelCommand(
                        "study.skip",
                        "Skip stage requested",
                        ctx.notify,
                      )
                    }
                  >
                    <SkipForward aria-hidden="true" size={13} />
                    <span>Skip</span>
                  </Button>
                  <Button
                    size="sm"
                    type="button"
                    variant="danger"
                    onClick={() =>
                      void executeKernelCommand(
                        "study.stop",
                        "Stop requested",
                        ctx.notify,
                      )
                    }
                  >
                    <Square aria-hidden="true" size={13} />
                    <span>Stop</span>
                  </Button>
                </div>
              ),
            },
            {
              label: "Postprocess",
              type: "custom",
              wide: true,
              render: (ctx) => (
                <div className="flex flex-wrap gap-1.5">
                  <Button
                    size="sm"
                    type="button"
                    variant="secondary"
                    onClick={() =>
                      void executeKernelCommand(
                        "study.compute-observables",
                        "Observable postprocessing queued",
                        ctx.notify,
                      )
                    }
                  >
                    <Gauge aria-hidden="true" size={13} />
                    <span>Compute observables</span>
                  </Button>
                  <Button
                    size="sm"
                    type="button"
                    variant="secondary"
                    onClick={() =>
                      void executeKernelCommand(
                        "study.compute-energies",
                        "Energy postprocessing queued",
                        ctx.notify,
                      )
                    }
                  >
                    <Sigma aria-hidden="true" size={13} />
                    <span>Compute energies</span>
                  </Button>
                </div>
              ),
            },
          ],
        },
        ...(runtimeModel
          ? [
              {
                id: "runtime-telemetry",
                title: "Runtime Telemetry & Provenance",
                icon: Activity,
                defaultOpen: true,
                summary: () => runtimeModel.runtime.state,
                rows: [
                  {
                    type: "custom" as const,
                    wide: true,
                    render: () => {
                      const rawSimTime =
                        typeof solverStatus?.sim_time_seconds === "number" &&
                        Number.isFinite(solverStatus.sim_time_seconds)
                          ? solverStatus.sim_time_seconds
                          : typeof solverStatus?.pseudo_time_seconds === "number" &&
                              Number.isFinite(solverStatus.pseudo_time_seconds)
                            ? solverStatus.pseudo_time_seconds
                            : null;
                      const simTimeVal =
                        rawSimTime !== null
                          ? `${rawSimTime.toExponential(3)} s`
                          : "—";
                      const stepVal =
                        typeof solverStatus?.step_index === "number" &&
                        Number.isFinite(solverStatus.step_index)
                          ? String(solverStatus.step_index)
                          : "—";
                      const maxTorqueVal =
                        !runtimeModel.runtime.maxTorque ||
                        runtimeModel.runtime.maxTorque === "unavailable"
                          ? "—"
                          : runtimeModel.runtime.maxTorque;
                      const maxRhsNormVal =
                        !runtimeModel.runtime.maxRhsNorm ||
                        runtimeModel.runtime.maxRhsNorm === "unavailable"
                          ? "—"
                          : runtimeModel.runtime.maxRhsNorm;
                      const relaxStopVal = runtimeModel.runtime.relaxTorqueStop
                        ? `${
                            runtimeModel.runtime.relaxTorqueStop.current ===
                            "unavailable"
                              ? "—"
                              : runtimeModel.runtime.relaxTorqueStop.current
                          } / ${runtimeModel.runtime.relaxTorqueStop.threshold}`
                        : "—";
                      return (
                        <div className="grid gap-2 text-xs">
                          <StudyProgressBar
                            label="Current study progress"
                            value={runtimeModel.runtime.progressPercent}
                          />
                          <div className="grid grid-cols-2 gap-2 rounded border border-fm-border-subtle p-2.5 tabular-nums">
                            <div>
                              <span className="block text-fm-muted">Active stage</span>
                              <span>{runtimeModel.runtime.activeStageLabel || "—"}</span>
                            </div>
                            <div>
                              <span className="block text-fm-muted">State</span>
                              <span>{runtimeModel.runtime.state || "idle"}</span>
                            </div>
                            <div>
                              <span className="block text-fm-muted">Sim time</span>
                              <span>{simTimeVal}</span>
                            </div>
                            <div>
                              <span className="block text-fm-muted">Step</span>
                              <span>{stepVal}</span>
                            </div>
                            <div>
                              <span className="block text-fm-muted">Max |m × H|</span>
                              <span>{maxTorqueVal}</span>
                            </div>
                            <div>
                              <span className="block text-fm-muted">Max RHS norm</span>
                              <span>{maxRhsNormVal}</span>
                            </div>
                            <div>
                              <span className="block text-fm-muted">Converged</span>
                              <span>{runtimeModel.runtime.converged ?? "—"}</span>
                            </div>
                            <div>
                              <span className="block text-fm-muted">Relax stop criteria</span>
                              <span>{relaxStopVal}</span>
                            </div>
                          </div>
                          {runtimeModel.runtime.commandId ? (
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-fm-muted">Active command</span>
                              <Button
                                size="sm"
                                type="button"
                                variant="ghost"
                                onClick={() =>
                                  setSelectedCommandId(
                                    runtimeModel.runtime.commandId ?? null,
                                  )
                                }
                              >
                                <span>{runtimeModel.runtime.commandLabel}</span>
                                <Info aria-hidden="true" size={12} />
                              </Button>
                            </div>
                          ) : null}
                          {runtimeModel.runtime.runtimeProvenance ? (
                            <div className="grid gap-1 rounded border border-fm-border-subtle p-2 font-mono text-xs">
                              <div>
                                Authored:{" "}
                                {runtimeModel.runtime.runtimeProvenance.authored.backend} /{" "}
                                {runtimeModel.runtime.runtimeProvenance.authored.device} ·{" "}
                                {runtimeModel.runtime.runtimeProvenance.authored.precision}
                              </div>
                              <div>
                                Resolved:{" "}
                                {runtimeModel.runtime.runtimeProvenance.resolved.backend !==
                                "not loaded"
                                  ? runtimeModel.runtime.runtimeProvenance.resolved.backend
                                  : (activeLane?.resolved?.discretization ?? "—")}{" "}
                                /{" "}
                                {runtimeModel.runtime.runtimeProvenance.resolved.device !==
                                "not loaded"
                                  ? runtimeModel.runtime.runtimeProvenance.resolved.device
                                  : (activeLane?.resolved?.device ?? "—")}{" "}
                                ·{" "}
                                {runtimeModel.runtime.runtimeProvenance.resolved.engine !==
                                "not loaded"
                                  ? runtimeModel.runtime.runtimeProvenance.resolved.engine
                                  : (activeLane?.resolved?.precision ?? "—")}
                              </div>
                              <div>
                                Fallback:{" "}
                                {runtimeModel.runtime.runtimeProvenance.fallback.status !==
                                "not loaded"
                                  ? runtimeModel.runtime.runtimeProvenance.fallback.status
                                  : "none"}
                              </div>
                            </div>
                          ) : null}
                        </div>
                      );
                    },
                  },
                ],
              },
            ]
          : []),
        {
          id: "pipeline-summary",
          title: "Pipeline summary",
          icon: Workflow,
          defaultOpen: true,
          summary: (d) => `${d.activeStageCount} stages`,
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <PipelineStrip
                  steps={ctx.draft.pipelineSteps}
                  onSelectStep={(step) => {
                    if (step.selection) ctx.selectNode(step.selection);
                  }}
                />
              ),
            },
            {
              label: "Pipeline order",
              type: "custom",
              render: (ctx) => (
                <Button
                  size="sm"
                  type="button"
                  variant="secondary"
                  onClick={() =>
                    ctx.selectNode({
                      kind: "study.stages",
                      label: "Stages",
                      nodeId: "model:study:stages",
                      objectId: null,
                      ref: {
                        kind: "study.stages",
                        nodeId: "model:study:stages",
                        type: "study",
                      },
                    })
                  }
                >
                  Open Stages manager →
                </Button>
              ),
            },
          ],
        },
        {
          id: "readiness-checklist",
          title: "Readiness checklist",
          icon: CheckCircle2,
          defaultOpen: false,
          summary: (d) =>
            d.preflightErrorCount > 0
              ? `${d.preflightErrorCount} preflight issues`
              : "Preflight ready",
          rows: [
            {
              label: "Geometry & Materials",
              type: "readonly",
              format: (d) =>
                `Ready (${d.magnetCount} magnetic ${d.magnetCount === 1 ? "body" : "bodies"})`,
            },
            {
              label: "Execution lane",
              type: "readonly",
              format: (d) => d.laneSummary,
            },
            {
              label: "Stage sequence",
              type: "readonly",
              format: (d) =>
                d.skippedStageCount > 0
                  ? `${d.activeStageCount} active · ${d.skippedStageCount} skipped`
                  : `${d.activeStageCount} ordered pipeline steps`,
            },
          ],
        },
        ...(canSubscribeResources
          ? [
              {
                id: "project-runs-batches",
                title: "Project Runs & Batches",
                icon: History,
                defaultOpen: false,
                rows: [
                  {
                    type: "custom" as const,
                    wide: true,
                    render: () => (
                      <div className="grid gap-3">
                        <ProjectRunsSection />
                        <ProjectBatchesSection />
                      </div>
                    ),
                  },
                ],
              },
            ]
          : []),
      ],
      details: (draft) => [
        { label: "Scene revision", value: `rev ${draft.sceneRevision}`, mono: true },
        { label: "Commands endpoint", value: SIMULATION_COMMANDS_PATH, mono: true },
      ],
      commitBar: {
        mode: "immediate",
        statusMessage: (d) => `Ready to compute scene revision ${d.sceneRevision}`,
      },
    }),
    [
      activeLane,
      baseline.isRunning,
      baseline.pipelineSteps,
      canSubscribeResources,
      executeKernelCommand,
      lastAuthoringError,
      preflightBlockers,
      runScopedStudyCompute,
      runtimeModel,
      solverStatus,
    ],
  );

  return (
    <>
      <ConnectedInspectorSpec
        baseline={baseline}
        selection={selection}
        spec={spec}
        onAfterFieldChange={(key, value) => {
          if (!commitStudyMetadata) return;
          if (key === "name" && typeof value === "string" && value.trim()) {
            void commitStudyMetadata({ name: value.trim() });
          } else if (key === "executionTrigger" && typeof value === "string") {
            void commitStudyMetadata({ execution_trigger: value });
          }
        }}
      />
      {canSubscribeResources && selectedCommandId ? (
        <ConnectedCommandDetailModal
          commandId={selectedCommandId}
          onClose={() => setSelectedCommandId(null)}
        />
      ) : null}
    </>
  );
}

function ConnectedCommandDetailModal({
  commandId,
  onClose,
}: {
  commandId: string;
  onClose: () => void;
}) {
  const detail = useCommandDetailResource(commandId);
  return (
    <CommandDetailDialog
      commandId={commandId}
      detail={detail}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    />
  );
}

/* ── 2. study.execution — StudyExecutionInspectorPanel ──────────────────── */

function parseVector3Text(
  raw: string,
  fallback: readonly [number, number, number] = [0, 0, 0],
): readonly [number, number, number] {
  const parts = raw
    .replace(/^\[|\]$/g, "")
    .split(/[\s,]+/)
    .map((item) => Number(item.trim()));
  if (parts.length === 3 && parts.every(Number.isFinite)) {
    return [parts[0]!, parts[1]!, parts[2]!];
  }
  return fallback;
}

function StudyExecutionProfileRadixCard({
  onApplyAssignment,
  sceneData,
  stages,
}: {
  onApplyAssignment: (assignment: StudyExecutionProfileAssignment) => Promise<boolean>;
  sceneData: SceneResource | null;
  stages: readonly unknown[];
}) {
  const resource = useExecutionProfilesResource();
  const canonicalDraft = useMemo(
    () => createStudyExecutionProfileDraft(sceneData),
    [sceneData],
  );
  const canonicalKey = useMemo(() => JSON.stringify(canonicalDraft), [canonicalDraft]);
  const [draftState, setDraftState] = useState<{
    baseKey: string;
    value: StudyExecutionProfileDraft;
  }>(() => ({ baseKey: canonicalKey, value: canonicalDraft }));
  const draft =
    draftState.baseKey === canonicalKey ? draftState.value : canonicalDraft;
  const setDraft = useCallback(
    (
      updater:
        | StudyExecutionProfileDraft
        | ((prev: StudyExecutionProfileDraft) => StudyExecutionProfileDraft),
    ) => {
      setDraftState((prev) => {
        const current =
          prev.baseKey === canonicalKey ? prev.value : canonicalDraft;
        const next = typeof updater === "function" ? updater(current) : updater;
        return { baseKey: canonicalKey, value: next };
      });
    },
    [canonicalDraft, canonicalKey],
  );
  const [applying, setApplying] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const dirty = studyExecutionProfileDraftIsDirty(draft, canonicalDraft);
  const validationError = validateStudyExecutionProfileDraft(draft);
  const hasChangeDeviceConflict =
    draft.profile !== null && hasChangeDeviceStudyStage(sceneData, stages);
  const profiles = resource.data?.entries.map((entry) => entry.profile) ?? [];
  const selectedKey = draft.profile
    ? studyExecutionProfileKey(draft.profile)
    : "__legacy__";
  const profileNotInCatalog =
    draft.profile !== null &&
    !profiles.some((p) => sameStudyExecutionProfile(p, draft.profile));

  const setOverride = (key: StudyExecutionProfileOverrideKey, value: string) => {
    setDraft((prev) => updateStudyExecutionProfileOverride(prev, key, value));
    setFeedback(null);
  };

  return (
    <div className="grid gap-2 rounded-md border border-fm-border-subtle p-2.5 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold text-fm-primary">
          Immutable Execution Profile
        </span>
        <Badge>
          {draft.profile
            ? `${draft.profile.profile_id} · ${draft.profile.version}`
            : "Legacy"}
        </Badge>
      </div>

      <div className="fm-inspector-row" data-layout="inline">
        <span className="fm-inspector-row__label">Profile version</span>
        <div className="fm-inspector-row__control">
          <Select
            value={selectedKey}
            onValueChange={(key) => {
              const found =
                key === "__legacy__"
                  ? null
                  : profiles.find((p) => studyExecutionProfileKey(p) === key) ??
                    (draft.profile && studyExecutionProfileKey(draft.profile) === key
                      ? draft.profile
                      : null);
              setDraft((prev) => selectStudyExecutionProfile(prev, found));
              setFeedback(null);
            }}
          >
            <SelectTrigger aria-label="Immutable profile version" density="compact">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__legacy__">
                None · use direct study settings
              </SelectItem>
              {profileNotInCatalog && draft.profile ? (
                <SelectItem value={selectedKey}>
                  {draft.profile.profile_id} · {draft.profile.version} (current)
                </SelectItem>
              ) : null}
              {profiles.map((p) => (
                <SelectItem
                  key={studyExecutionProfileKey(p)}
                  value={studyExecutionProfileKey(p)}
                >
                  {p.profile_id} · {p.version}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {draft.profile !== null ? (
        <div className="grid gap-1.5 border-t border-fm-border-subtle pt-2">
          <div className="fm-inspector-row" data-layout="inline">
            <span className="fm-inspector-row__label">Backend override</span>
            <div className="fm-inspector-row__control">
              <Select
                value={draft.overrides.backend || "__inherit__"}
                onValueChange={(v) =>
                  setOverride("backend", v === "__inherit__" ? "" : v)
                }
              >
                <SelectTrigger aria-label="Backend override" density="compact">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__inherit__">Inherit</SelectItem>
                  <SelectItem value="auto">Auto</SelectItem>
                  <SelectItem value="fdm">FDM</SelectItem>
                  <SelectItem value="fem">FEM</SelectItem>
                  <SelectItem value="hybrid">Hybrid</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="fm-inspector-row" data-layout="inline">
            <span className="fm-inspector-row__label">Device override</span>
            <div className="fm-inspector-row__control">
              <Select
                value={draft.overrides.device || "__inherit__"}
                onValueChange={(v) =>
                  setOverride("device", v === "__inherit__" ? "" : v)
                }
              >
                <SelectTrigger aria-label="Device override" density="compact">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__inherit__">Inherit</SelectItem>
                  <SelectItem value="auto">Auto</SelectItem>
                  <SelectItem value="cpu">CPU</SelectItem>
                  <SelectItem value="gpu">GPU</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="fm-inspector-row" data-layout="inline">
            <span className="fm-inspector-row__label">Precision override</span>
            <div className="fm-inspector-row__control">
              <Select
                value={draft.overrides.precision || "__inherit__"}
                onValueChange={(v) =>
                  setOverride("precision", v === "__inherit__" ? "" : v)
                }
              >
                <SelectTrigger aria-label="Precision override" density="compact">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__inherit__">Inherit</SelectItem>
                  <SelectItem value="double">Double (FP64)</SelectItem>
                  <SelectItem value="single">Single (FP32)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="fm-inspector-row" data-layout="inline">
            <span className="fm-inspector-row__label">Mode override</span>
            <div className="fm-inspector-row__control">
              <Select
                value={draft.overrides.mode || "__inherit__"}
                onValueChange={(v) =>
                  setOverride("mode", v === "__inherit__" ? "" : v)
                }
              >
                <SelectTrigger aria-label="Execution mode override" density="compact">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__inherit__">Inherit</SelectItem>
                  <SelectItem value="strict">Strict</SelectItem>
                  <SelectItem value="extended">Extended</SelectItem>
                  <SelectItem value="hybrid">Hybrid</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="fm-inspector-row" data-layout="inline">
            <span className="fm-inspector-row__label">CPU threads override</span>
            <div className="fm-inspector-row__control">
              <Input
                aria-label="CPU threads override"
                className="h-fm-control-sm font-mono"
                placeholder="Inherit or integer"
                value={draft.overrides.cpuThreads}
                onChange={(e) => setOverride("cpuThreads", e.target.value)}
              />
            </div>
          </div>
        </div>
      ) : null}

      {hasChangeDeviceConflict ? (
        <div className="text-fm-danger" role="alert">
          Remove the Change Device stage or clear the execution profile before applying.
        </div>
      ) : validationError ? (
        <div className="text-fm-danger" role="alert">
          {validationError}
        </div>
      ) : feedback ? (
        <div className="text-fm-muted" role="status">
          {feedback}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-1.5">
        <Button
          disabled={applying || resource.status === "loading"}
          size="sm"
          type="button"
          variant="secondary"
          onClick={() => resource.refetch()}
        >
          Refresh profiles
        </Button>
        <Button
          disabled={
            !dirty ||
            applying ||
            Boolean(validationError) ||
            hasChangeDeviceConflict
          }
          size="sm"
          type="button"
          variant="primary"
          onClick={async () => {
            try {
              setApplying(true);
              const assignment = buildStudyExecutionProfileAssignment(draft);
              const ok = await onApplyAssignment(assignment);
              setFeedback(
                ok ? "Execution profile saved." : "Could not save execution profile.",
              );
            } catch (err) {
              setFeedback(err instanceof Error ? err.message : "Invalid profile.");
            } finally {
              setApplying(false);
            }
          }}
        >
          Save profile binding
        </Button>
        <Button
          disabled={!dirty || applying}
          size="sm"
          type="button"
          variant="ghost"
          onClick={() => {
            setDraft(canonicalDraft);
            setFeedback(null);
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

export function StudyExecutionInspectorPanel({
  selection,
  testSnapshot,
}: InspectorPanelProps & {
  testSnapshot?: StudyExecutionTestSnapshot;
}) {
  const kernel = useContext(KernelContext);
  if (kernel && !testSnapshot) {
    return <ConnectedStudyExecutionInspectorPanel selection={selection} />;
  }
  return (
    <StudyExecutionInspectorPanelView
      selection={selection}
      testSnapshot={testSnapshot}
    />
  );
}

function ConnectedStudyExecutionInspectorPanel({
  selection,
}: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  const {
    commitExecutionProfile,
    commitGlobalDraft,
    globalDraft,
    lastAuthoringError,
    requestedDiscretization,
    runtimeStatus,
    sceneData,
    sceneRevision,
    sessionDiscretization,
    sessionScopeKey,
    stageDrafts,
  } = useKernelStudyAuthoring(selection);

  const hydratedBaseline = useMemo<StudyExecutionDraft>(() => {
    const capRecord = (runtimeStatus?.capabilities ?? {}) as unknown as Record<
      string,
      unknown
    >;
    const resolvedDev =
      runtimeStatus?.capabilities?.active_lane?.resolved?.device ?? "";
    const devicesAvailable = Array.isArray(capRecord.devices_available)
      ? (capRecord.devices_available as string[])
      : [];
    const cudaAvailable =
      typeof capRecord.cuda_available === "boolean"
        ? capRecord.cuda_available
        : devicesAvailable.some((d) => d === "gpu" || d.startsWith("cuda")) ||
          resolvedDev === "gpu" ||
          resolvedDev.startsWith("cuda");
    const rawDev = globalDraft.requestedDevice.toLowerCase();
    const requestedDevice: StudyExecutionDraft["requestedDevice"] =
      rawDev === "gpu" || rawDev.startsWith("cuda")
        ? "gpu"
        : rawDev === "cpu"
          ? "cpu"
          : "auto";
    const rawDisc = globalDraft.requestedBackend.toLowerCase();
    const discretization: StudyExecutionDraft["discretization"] =
      rawDisc === "fem"
        ? "fem"
        : rawDisc === "fdm"
          ? "fdm"
          : rawDisc === "hybrid"
            ? "hybrid"
            : "auto";
    const precision: StudyExecutionDraft["precision"] =
      globalDraft.requestedPrecision === "single" ? "single" : "double";
    const qualificationMode: StudyExecutionDraft["qualificationMode"] =
      globalDraft.requestedMode === "extended"
        ? "extended"
        : globalDraft.requestedMode === "hybrid"
          ? "hybrid"
          : "strict";
    const magnetCount = (sceneData?.objects ?? []).filter(
      (obj) => obj.role === "magnet",
    ).length;
    const rawStudyRecord =
      sceneData && typeof sceneData.study === "object" && sceneData.study
        ? (sceneData.study as Record<string, unknown>)
        : null;
    const rawStudyFdm =
      rawStudyRecord &&
      typeof rawStudyRecord.fdm === "object" &&
      rawStudyRecord.fdm &&
      !Array.isArray(rawStudyRecord.fdm)
        ? (rawStudyRecord.fdm as Record<string, unknown>)
        : null;
    const rawStudyFdmDemag =
      rawStudyFdm &&
      typeof rawStudyFdm.demag === "object" &&
      rawStudyFdm.demag &&
      !Array.isArray(rawStudyFdm.demag)
        ? (rawStudyFdm.demag as Record<string, unknown>)
        : null;
    const fdm = globalDraft.fdm;
    const adv = globalDraft.solver.adaptiveTimestep;
    const profileBound = sceneData ? hasStudyExecutionProfile(sceneData) : false;
    const normalizedDemag = normalizeDemagRealizationForLane(
      globalDraft.demagRealization,
      {
        requestedBackend: profileBound ? null : globalDraft.requestedBackend,
        requestedDiscretization,
        sessionDiscretization,
      },
    );
    const femDemagSolver: StudyExecutionDraft["femDemagSolver"] =
      normalizedDemag === "poisson_robin" ||
      normalizedDemag === "poisson_dirichlet" ||
      normalizedDemag === "fredkin_koehler" ||
      normalizedDemag === "bem" ||
      normalizedDemag === "fmm" ||
      normalizedDemag === "airbox_robin"
        ? normalizedDemag
        : "auto";
    const fallbackDefaultCell = Array.isArray(rawStudyFdm?.default_cell)
      ? rawStudyFdm.default_cell.join(", ")
      : "";
    const fallbackPerMagnet =
      rawStudyFdm?.per_magnet && typeof rawStudyFdm.per_magnet === "object"
        ? JSON.stringify(rawStudyFdm.per_magnet)
        : "";
    const fallbackCommonCells = Array.isArray(rawStudyFdmDemag?.common_cells)
      ? rawStudyFdmDemag.common_cells.join(", ")
      : "";
    const fallbackCommonCellsXy = Array.isArray(rawStudyFdmDemag?.common_cells_xy)
      ? rawStudyFdmDemag.common_cells_xy.join(", ")
      : "";
    const rawDemagMode =
      fdm?.demagMode ??
      (typeof rawStudyFdmDemag?.mode === "string" ? rawStudyFdmDemag.mode : "auto");
    const rawBoundaryCorrection =
      fdm?.boundaryCorrection ??
      (typeof rawStudyFdm?.boundary_correction === "string"
        ? rawStudyFdm.boundary_correction
        : "");

    return {
      executionProfile: profileBound ? "bound" : "direct",
      discretization,
      requestedDevice,
      precision,
      qualificationMode,
      cpuThreadsText: globalDraft.requestedCpuThreads ?? "",
      parallelMode:
        globalDraft.parallelExecution.mode === "adaptive"
          ? "adaptive"
          : "serial",
      maxWorkers: Number(globalDraft.parallelExecution.maxWorkers) || 4,
      threadsPerWorker:
        Number(globalDraft.parallelExecution.threadsPerWorker) || 1,
      maxCpuPercent: Number(globalDraft.parallelExecution.maxCpuPercent) || 90,
      maxMemoryPercent:
        Number(globalDraft.parallelExecution.maxMemoryPercent) || 80,
      memoryReserveBytes:
        (Number(globalDraft.parallelExecution.memoryReserveMiB) || 1024) *
        1024 *
        1024,
      exchangeEnabled: globalDraft.exchangeEnabled,
      demagEnabled: globalDraft.demagEnabled,
      fdmDemagStrategy:
        normalizedDemag === "single_grid"
          ? "single_grid"
          : normalizedDemag === "multilayer_convolution"
            ? "multilayer_convolution"
            : "auto",
      fdmDemagMode:
        rawDemagMode === "two_d_stack" || rawDemagMode === "three_d"
          ? rawDemagMode
          : "auto",
      fdmDefaultCell: fdm?.defaultCell ?? fallbackDefaultCell,
      fdmPerMagnet: fdm?.perMagnet ?? fallbackPerMagnet,
      fdmCommonCells: fdm?.commonCells ?? fallbackCommonCells,
      fdmCommonCellsXy: fdm?.commonCellsXy ?? fallbackCommonCellsXy,
      fdmDemagExplain:
        fdm?.demagExplain ??
        (typeof rawStudyFdmDemag?.explain === "boolean"
          ? rawStudyFdmDemag.explain
          : true),
      fdmBoundaryCorrection: rawBoundaryCorrection || "engine_default",
      boundaryPhiFloor:
        Number(fdm?.boundaryPhiFloor ?? rawStudyFdm?.boundary_phi_floor) || 0.05,
      boundaryDeltaMinM:
        Number(fdm?.boundaryDeltaMin ?? rawStudyFdm?.boundary_delta_min) || 1e-10,
      femDemagSolver,
      femDemagPolicyJson: globalDraft.femDemagSolverPolicy || "",
      externalFieldTesla: parseVector3Text(globalDraft.externalField),
      defaultIntegrator:
        globalDraft.solver.integrator === "heun" ||
        globalDraft.solver.integrator === "rk23" ||
        globalDraft.solver.integrator === "rk45"
          ? globalDraft.solver.integrator
          : "auto",
      defaultTimestepMode: globalDraft.solver.timestepMode || "auto",
      defaultFixedDtS: Number(globalDraft.solver.fixDt) || 1e-13,
      defaultDtInitS:
        Number(adv?.dtInitial || globalDraft.solver.dtInitial) || 5e-14,
      defaultDtMinS: Number(adv?.dtMin || globalDraft.solver.dtMin) || 1e-15,
      defaultDtMaxS: Number(adv?.dtMax || globalDraft.solver.dtMax) || 1e-11,
      defaultMaxErr: Number(globalDraft.solver.maxErr) || 1e-5,
      defaultAtol: Number(adv?.atol) || 1e-7,
      defaultRtol: Number(adv?.rtol) || 1e-5,
      defaultSafety: Number(adv?.safety) || 0.9,
      defaultGrowthLimit: Number(adv?.growthLimit) || 2,
      defaultShrinkLimit: Number(adv?.shrinkLimit) || 0.2,
      defaultMaxSpinRotation: adv?.maxSpinRotation ?? "",
      defaultNormTolerance: adv?.normTolerance ?? "",
      defaultDemagIntervalS: Number(globalDraft.solver.demagInterval) || 0,
      defaultRelaxAlgorithm:
        globalDraft.solver.relaxAlgorithm || "llg_overdamped",
      defaultTorqueToleranceApm:
        Number(globalDraft.solver.torqueTolerance) || 100,
      defaultEnergyToleranceJ:
        Number(globalDraft.solver.energyTolerance) || 1e-20,
      defaultMaxRelaxSteps: Number(globalDraft.solver.maxRelaxSteps) || 50000,
      advancedSolverJson: "{}",
      cudaAvailable,
      gpuName:
        typeof capRecord.gpu_name === "string" && capRecord.gpu_name
          ? capRecord.gpu_name
          : cudaAvailable
            ? "CUDA GPU"
            : null,
      cpuThreadCap:
        typeof capRecord.cpu_thread_count === "number"
          ? capRecord.cpu_thread_count
          : typeof capRecord.cpu_threads === "number"
            ? capRecord.cpu_threads
            : 16,
      magneticObjectCount: magnetCount,
      hasChangeDeviceStage: stageDrafts.some((s) => s.kind === "change_device"),
      executionProfileBound: profileBound,
      requestedDiscretization,
      sessionDiscretization,
    };
  }, [
    globalDraft,
    requestedDiscretization,
    runtimeStatus,
    sceneData,
    sessionDiscretization,
    stageDrafts,
  ]);

  const handleApplyFdmGrid = useCallback(async () => {
    if (!kernel) return;
    await runFdmGridRefreshOperation(
      buildStudyCommandContext(kernel, {
        runtimeStatus,
        sceneData,
        sessionScopeKey: sessionScopeKey ?? undefined,
        sourceDetail: "study-execution",
      }),
      {
        kind: "fdm_grid_refresh",
        ...(sceneRevision !== null
          ? { precondition: { scene_revision: sceneRevision } }
          : {}),
        reason: "study-execution",
      },
    );
  }, [kernel, runtimeStatus, sceneData, sceneRevision, sessionScopeKey]);

  return (
    <StudyExecutionInspectorPanelView
      globalDraftForPreview={globalDraft}
      hydratedBaseline={hydratedBaseline}
      lastAuthoringError={lastAuthoringError}
      sceneData={sceneData}
      selection={selection}
      stageDrafts={stageDrafts}
      onApplyFdmGrid={handleApplyFdmGrid}
      onApplyProfile={commitExecutionProfile}
      onCommitExecution={(draft) => {
        const explicitFdm = isExplicitFdmDraft(draft);
        return commitGlobalDraft((base) => ({
          ...base,
          requestedBackend: draft.discretization,
          requestedDevice: draft.requestedDevice,
          requestedPrecision: draft.precision,
          requestedMode: draft.qualificationMode,
          exchangeEnabled: draft.exchangeEnabled,
          demagEnabled: draft.demagEnabled,
          demagRealization: explicitFdm
            ? draft.fdmDemagStrategy
            : draft.femDemagSolver,
          femDemagSolverPolicy: !explicitFdm
            ? draft.femDemagPolicyJson
            : base.femDemagSolverPolicy,
          ...(explicitFdm
            ? {
                fdm: {
                  boundaryCorrection:
                    draft.fdmBoundaryCorrection === "engine_default"
                      ? ""
                      : draft.fdmBoundaryCorrection,
                  boundaryDeltaMin:
                    draft.fdmBoundaryCorrection === "full"
                      ? String(draft.boundaryDeltaMinM)
                      : base.fdm?.boundaryDeltaMin ?? "",
                  boundaryPhiFloor:
                    draft.fdmBoundaryCorrection === "volume" ||
                    draft.fdmBoundaryCorrection === "full"
                      ? String(draft.boundaryPhiFloor)
                      : base.fdm?.boundaryPhiFloor ?? "",
                  commonCells: draft.fdmCommonCells,
                  commonCellsXy: draft.fdmCommonCellsXy,
                  defaultCell: draft.fdmDefaultCell,
                  demagExplain: draft.fdmDemagExplain,
                  demagMode: draft.fdmDemagMode,
                  demagStrategy: draft.fdmDemagStrategy,
                  perMagnet: draft.fdmPerMagnet,
                },
              }
            : {}),
          externalField: draft.externalFieldTesla.join(", "),
          requestedCpuThreads:
            draft.requestedDevice !== "gpu"
              ? draft.cpuThreadsText.trim()
              : base.requestedCpuThreads,
          parallelExecution: {
            ...base.parallelExecution,
            mode: draft.parallelMode,
            maxCpuPercent: String(draft.maxCpuPercent),
            maxMemoryPercent: String(draft.maxMemoryPercent),
            memoryReserveMiB: String(
              Math.max(0, Math.round(draft.memoryReserveBytes / (1024 * 1024))),
            ),
            maxWorkers:
              draft.parallelMode === "adaptive"
                ? String(draft.maxWorkers)
                : base.parallelExecution.maxWorkers,
            threadsPerWorker: String(draft.threadsPerWorker),
          },
          solver: {
            ...base.solver,
            integrator:
              draft.defaultIntegrator === "auto" ? "" : draft.defaultIntegrator,
            timestepMode: draft.defaultTimestepMode,
            fixDt:
              draft.defaultTimestepMode === "fixed"
                ? String(draft.defaultFixedDtS)
                : base.solver.fixDt,
            dtInitial:
              draft.defaultTimestepMode === "adaptive_max_error"
                ? String(draft.defaultDtInitS)
                : base.solver.dtInitial,
            dtMin:
              draft.defaultTimestepMode === "adaptive_max_error"
                ? String(draft.defaultDtMinS)
                : base.solver.dtMin,
            dtMax:
              draft.defaultTimestepMode === "adaptive_max_error"
                ? String(draft.defaultDtMaxS)
                : base.solver.dtMax,
            maxErr:
              draft.defaultTimestepMode === "adaptive_max_error"
                ? String(draft.defaultMaxErr)
                : base.solver.maxErr,
            adaptiveTimestep:
              draft.defaultTimestepMode === "adaptive_advanced"
                ? {
                    atol: String(draft.defaultAtol),
                    rtol: String(draft.defaultRtol),
                    dtInitial: String(draft.defaultDtInitS),
                    dtMin: String(draft.defaultDtMinS),
                    dtMax: String(draft.defaultDtMaxS),
                    safety: String(draft.defaultSafety),
                    growthLimit: String(draft.defaultGrowthLimit),
                    shrinkLimit: String(draft.defaultShrinkLimit),
                    maxSpinRotation: draft.defaultMaxSpinRotation,
                    normTolerance: draft.defaultNormTolerance,
                  }
                : base.solver.adaptiveTimestep,
            demagInterval:
              draft.defaultDemagIntervalS > 0
                ? String(draft.defaultDemagIntervalS)
                : "",
            relaxAlgorithm: draft.defaultRelaxAlgorithm,
            torqueTolerance: String(draft.defaultTorqueToleranceApm),
            energyTolerance: String(draft.defaultEnergyToleranceJ),
            maxRelaxSteps: String(draft.defaultMaxRelaxSteps),
          },
        }));
      }}
    />
  );
}

function StudyExecutionInspectorPanelView({
  globalDraftForPreview,
  hydratedBaseline,
  lastAuthoringError = null,
  onApplyFdmGrid,
  onApplyProfile,
  onCommitExecution,
  sceneData = null,
  selection,
  stageDrafts = [],
  testSnapshot,
}: InspectorPanelProps & {
  globalDraftForPreview?: StudyGlobalDraft;
  hydratedBaseline?: StudyExecutionDraft;
  lastAuthoringError?: string | null;
  onApplyFdmGrid?: () => Promise<void>;
  onApplyProfile?: (assignment: StudyExecutionProfileAssignment) => Promise<boolean>;
  onCommitExecution?: (draft: StudyExecutionDraft) => Promise<boolean>;
  sceneData?: SceneResource | null;
  stageDrafts?: readonly StudyStageDraft[];
  testSnapshot?: StudyExecutionTestSnapshot;
}) {
  const kernel = useContext(KernelContext);
  const canSubscribeResources = hasSubscribableResourceStore(kernel);
  const fallbackBaseline = useMemo<StudyExecutionDraft>(() => {
    const cudaAvailable = testSnapshot?.cudaAvailable ?? true;
    const rawDev = testSnapshot?.requestedDevice ?? "auto";
    return {
      executionProfile: "direct",
      discretization: testSnapshot?.discretization ?? "fdm",
      requestedDevice: rawDev,
      precision: testSnapshot?.precision ?? "double",
      qualificationMode: testSnapshot?.qualificationMode ?? "strict",
      cpuThreadsText: "",
      parallelMode: "serial",
      maxWorkers: 4,
      threadsPerWorker: 1,
      maxCpuPercent: 90,
      maxMemoryPercent: 80,
      memoryReserveBytes: 1024 * 1024 * 1024,
      exchangeEnabled: true,
      demagEnabled: true,
      fdmDemagStrategy: "auto",
      fdmDemagMode: "auto",
      fdmDefaultCell: "",
      fdmPerMagnet: "",
      fdmCommonCells: "",
      fdmCommonCellsXy: "",
      fdmDemagExplain: true,
      fdmBoundaryCorrection: "engine_default",
      boundaryPhiFloor: 0.05,
      boundaryDeltaMinM: 1e-10,
      femDemagSolver: "auto",
      femDemagPolicyJson: "",
      externalFieldTesla: [0, 0, 0],
      defaultIntegrator: "auto",
      defaultTimestepMode: "auto",
      defaultFixedDtS: 1e-13,
      defaultDtInitS: 5e-14,
      defaultDtMinS: 1e-15,
      defaultDtMaxS: 1e-11,
      defaultMaxErr: 1e-5,
      defaultAtol: 1e-7,
      defaultRtol: 1e-5,
      defaultSafety: 0.9,
      defaultGrowthLimit: 2,
      defaultShrinkLimit: 0.2,
      defaultMaxSpinRotation: "",
      defaultNormTolerance: "",
      defaultDemagIntervalS: 0,
      defaultRelaxAlgorithm: "llg_overdamped",
      defaultTorqueToleranceApm: 100,
      defaultEnergyToleranceJ: 1e-20,
      defaultMaxRelaxSteps: 50000,
      advancedSolverJson: "{}",
      cudaAvailable,
      gpuName: cudaAvailable ? "NVIDIA CUDA GPU" : null,
      cpuThreadCap: 16,
      magneticObjectCount: testSnapshot?.magneticObjectCount ?? 1,
      hasChangeDeviceStage: false,
      executionProfileBound: false,
      requestedDiscretization: null,
      sessionDiscretization:
        testSnapshot?.sessionDiscretization !== undefined
          ? testSnapshot.sessionDiscretization
          : testSnapshot?.discretization === "fem"
            ? "fem"
            : "fdm",
    };
  }, [
    testSnapshot?.cudaAvailable,
    testSnapshot?.discretization,
    testSnapshot?.magneticObjectCount,
    testSnapshot?.precision,
    testSnapshot?.qualificationMode,
    testSnapshot?.requestedDevice,
    testSnapshot?.sessionDiscretization,
  ]);
  const baseline = hydratedBaseline ?? fallbackBaseline;

  const spec = useMemo<InspectorSpec<StudyExecutionDraft>>(
    () => ({
      id: "study.execution",
      header: {
        breadcrumbs: studyBreadcrumbs("Execution"),
        canFitView: true,
      },
      identity: {
        domain: "study",
        icon: Cpu,
        title: () => "Execution",
        kindLabel: "Discretization & hardware realization",
        entityId: "study:execution",
        statePill: (draft) => {
          const resolved = resolveEffectiveDeviceDisplay(draft);
          if (resolved.blockedGpu) {
            return { tone: "err", label: "GPU unavailable" };
          }
          if (draft.requestedDevice === "auto") {
            return { tone: "info", label: "Auto-resolved" };
          }
          return { tone: "ok", label: "Qualified" };
        },
      },
      facts: (draft): readonly InspectorFact[] => {
        const resolved = resolveEffectiveDeviceDisplay(draft);
        const discLabel =
          draft.discretization === "auto"
            ? isExplicitFdmDraft(draft)
              ? "Auto → FDM"
              : draft.sessionDiscretization === "fem"
                ? "Auto → FEM"
                : "Auto"
            : draft.discretization.toUpperCase();
        return [
          { id: "disc", label: "Discretization", value: discLabel },
          {
            id: "device",
            label: "Device",
            value: resolved.factValue,
            tone: resolved.blockedGpu ? "err" : "ok",
          },
          {
            id: "precision",
            label: "Precision",
            value: draft.precision === "double" ? "FP64" : "FP32",
          },
          {
            id: "qual",
            label: "Qualification",
            value:
              draft.qualificationMode === "strict"
                ? "Strict"
                : draft.qualificationMode === "hybrid"
                  ? "Hybrid"
                  : "Extended",
          },
        ];
      },
      modeTabs: [
        { id: "hardware", label: "Hardware & Lane" },
        { id: "physics", label: "Global Physics & Solver" },
      ],
      notices: (draft): readonly InspectorNotice<StudyExecutionDraft>[] => {
        const list: InspectorNotice<StudyExecutionDraft>[] = [];
        if (lastAuthoringError) {
          list.push({
            id: "exec-authoring-err",
            tone: "err",
            text: lastAuthoringError,
          });
        }
        const resolved = resolveEffectiveDeviceDisplay(draft);
        if (resolved.blockedGpu) {
          list.push({
            id: "explicit-gpu-blocked",
            tone: "err",
            title: "Explicit GPU execution is blocked",
            text: "No CUDA-capable GPU is available on this host. Fullmag never silently falls back to CPU when GPU is explicitly requested. Switch to Auto or Switch to CPU to proceed.",
            focusFieldKey: "requestedDevice",
            quickFix: {
              label: "Switch to Auto",
              onApply: (ctx) => {
                ctx.setField("requestedDevice", "auto");
              },
            },
          });
          list.push({
            id: "explicit-gpu-switch-cpu",
            tone: "warn",
            text: "Alternatively, select explicit CPU execution for multi-threaded host solve.",
            quickFix: {
              label: "Switch to CPU",
              ghost: true,
              onApply: (ctx) => {
                ctx.setField("requestedDevice", "cpu");
              },
            },
          });
        }
        if (
          isExplicitFdmDraft(draft) &&
          draft.fdmDemagStrategy === "single_grid" &&
          draft.magneticObjectCount > 1
        ) {
          list.push({
            id: "fdm-single-grid-multibody",
            tone: "err",
            text: "Single-grid FFT demagnetization supports 1 magnetic body; switch to Multilayer convolution for multi-body FDM.",
            quickFix: {
              label: "Switch to Multilayer convolution",
              onApply: (ctx) => ctx.setField("fdmDemagStrategy", "multilayer_convolution"),
            },
          });
        }
        if (
          draft.parallelMode === "adaptive" &&
          (draft.discretization !== "fem" || draft.requestedDevice !== "cpu")
        ) {
          list.push({
            id: "adaptive-pool-lane",
            tone: "err",
            text: "Adaptive worker pool requires explicit FEM discretization on CPU.",
            quickFix: {
              label: "Switch to Serial",
              onApply: (ctx) => ctx.setField("parallelMode", "serial"),
            },
          });
        }
        return list;
      },
      sections: [
        ...(canSubscribeResources && !testSnapshot && onApplyProfile
          ? [
              {
                id: "execution-profile",
                title: "Study Execution Profile",
                icon: Sliders,
                modeTabId: "hardware",
                defaultOpen: baseline.executionProfileBound,
                rows: [
                  {
                    type: "custom" as const,
                    wide: true,
                    render: () => (
                      <StudyExecutionProfileRadixCard
                        sceneData={sceneData}
                        stages={stageDrafts}
                        onApplyAssignment={onApplyProfile}
                      />
                    ),
                  },
                ],
              },
            ]
          : []),
        {
          id: "discretization-device",
          title: "Discretization & Device",
          icon: Cpu,
          modeTabId: "hardware",
          defaultOpen: true,
          summary: (d) =>
            `${d.discretization.toUpperCase()} · ${resolveEffectiveDeviceDisplay(d).factValue}`,
          rows: [
            {
              key: "discretization",
              label: "Discretization",
              type: "segmented",
              structural: true,
              disabledReason: (d) =>
                d.executionProfileBound
                  ? "Managed by bound execution profile."
                  : null,
              options: [
                { value: "auto", label: "Auto" },
                { value: "fdm", label: "FDM" },
                { value: "fem", label: "FEM" },
                { value: "hybrid", label: "Hybrid" },
              ],
            },
            {
              key: "requestedDevice",
              label: "Device",
              type: "segmented",
              structural: true,
              disabledReason: (d) =>
                d.executionProfileBound
                  ? "Managed by bound execution profile."
                  : null,
              validate: (val, d) =>
                val === "gpu" && !d.cudaAvailable
                  ? "No CUDA GPU detected; explicit GPU never falls back to CPU."
                  : null,
              options: [
                { value: "auto", label: "Auto" },
                { value: "gpu", label: "GPU (CUDA)" },
                { value: "cpu", label: "CPU" },
              ],
            },
            {
              label: "Resolved device",
              type: "readonly",
              showWhen: (d) => d.requestedDevice === "auto" || d.requestedDevice === "gpu",
              format: (d) => resolveEffectiveDeviceDisplay(d).readoutValue,
            },
            {
              key: "precision",
              label: "Precision",
              type: "segmented",
              disabledReason: (d) =>
                d.executionProfileBound
                  ? "Managed by bound execution profile."
                  : null,
              options: [
                { value: "double", label: "FP64 (Double)" },
                { value: "single", label: "FP32 (Single)" },
              ],
            },
            {
              key: "qualificationMode",
              label: "Qualification mode",
              type: "segmented",
              disabledReason: (d) =>
                d.executionProfileBound
                  ? "Managed by bound execution profile."
                  : null,
              options: [
                { value: "strict", label: "Strict" },
                { value: "extended", label: "Extended" },
                { value: "hybrid", label: "Hybrid" },
              ],
            },
          ],
        },
        {
          id: "compute-budget",
          title: "Compute & Memory Budget",
          icon: Gauge,
          modeTabId: "hardware",
          defaultOpen: true,
          summary: (d) =>
            `${d.parallelMode === "adaptive" ? "Adaptive pool" : "Serial"} · ${d.cpuThreadsText.trim() || "Auto"} threads`,
          rows: [
            {
              key: "cpuThreadsText",
              label: "CPU threads",
              symbol: (
                <>
                  N<sub>t</sub>
                </>
              ),
              type: "text",
              mono: true,
              placeholder: "Auto (host default)",
              disabledReason: (d) =>
                d.executionProfileBound
                  ? "Managed by bound execution profile."
                  : null,
              showWhen: (d) => d.requestedDevice !== "gpu",
              validate: (val) => {
                const trimmed = String(val ?? "").trim();
                if (!trimmed) return null;
                const parsed = Number(trimmed);
                return Number.isInteger(parsed) && parsed >= 1 && parsed <= 256
                  ? null
                  : "Enter blank (auto) or an integer thread count between 1 and 256.";
              },
            },
            {
              key: "parallelMode",
              label: "Independent k points",
              type: "segmented",
              structural: true,
              options: [
                { value: "serial", label: "Serial" },
                { value: "adaptive", label: "Adaptive pool" },
              ],
            },
            {
              key: "maxWorkers",
              label: "Max workers",
              symbol: (
                <>
                  N<sub>w</sub>
                </>
              ),
              type: "number",
              integer: true,
              min: 1,
              max: 64,
              showWhen: (d) => d.parallelMode === "adaptive",
            },
            {
              key: "threadsPerWorker",
              label: "Threads per worker",
              type: "number",
              integer: true,
              min: 1,
              max: 64,
              showWhen: (d) => d.parallelMode === "adaptive",
            },
            {
              key: "maxCpuPercent",
              label: "Max CPU share",
              type: "range",
              min: 10,
              max: 100,
              step: 5,
              unitSuffix: "%",
              showWhen: (d) => d.parallelMode === "adaptive",
            },
            {
              key: "maxMemoryPercent",
              label: "Max RAM share",
              type: "range",
              min: 10,
              max: 95,
              step: 5,
              unitSuffix: "%",
              showWhen: (d) => d.parallelMode === "adaptive",
            },
            {
              key: "memoryReserveBytes",
              label: "System RAM reserve",
              type: "quantity",
              units: MEMORY_BYTES_UNITS_SI,
              defaultDisplayUnit: "MiB",
              min: 0,
              showWhen: (d) => d.parallelMode === "adaptive",
            },
          ],
        },
        {
          id: "global-physics",
          title: "Global Field, Grid & Interactions",
          icon: Magnet,
          modeTabId: "physics",
          defaultOpen: true,
          summary: (d) =>
            `${d.exchangeEnabled ? "Exchange ON" : "Exchange OFF"} · ${d.demagEnabled ? "Demag ON" : "Demag OFF"}`,
          rows: [
            {
              key: "exchangeEnabled",
              label: "Exchange interaction",
              symbol: (
                <>
                  A<sub>ex</sub>
                </>
              ),
              type: "switch",
            },
            {
              key: "demagEnabled",
              label: "Demagnetization",
              symbol: (
                <>
                  H<sub>demag</sub>
                </>
              ),
              type: "switch",
              structural: true,
            },
            {
              key: "fdmDemagStrategy",
              label: "FDM demag realization",
              type: "select",
              showWhen: (d) => d.demagEnabled && isExplicitFdmDraft(d),
              options: [
                { value: "auto", label: "Auto" },
                { value: "single_grid", label: "Single FFT grid" },
                { value: "multilayer_convolution", label: "Multilayer convolution" },
              ],
            },
            {
              key: "fdmDemagMode",
              label: "FDM demag dimensionality",
              type: "segmented",
              showWhen: (d) => d.demagEnabled && isExplicitFdmDraft(d),
              options: [
                { value: "auto", label: "Auto" },
                { value: "two_d_stack", label: "2D stack" },
                { value: "three_d", label: "3D full" },
              ],
            },
            {
              key: "fdmDefaultCell",
              label: "FDM default cell (dx, dy, dz in m)",
              type: "text",
              mono: true,
              placeholder: "2e-9, 2e-9, 1e-9",
              showWhen: (d) => isExplicitFdmDraft(d),
            },
            {
              type: "custom",
              label: "FDM grid preview",
              wide: true,
              showWhen: (d) => isExplicitFdmDraft(d) && Boolean(sceneData),
              render: (ctx) => {
                if (!sceneData || !globalDraftForPreview) return null;
                const preview = resolveFdmGridPreview(sceneData, {
                  ...globalDraftForPreview,
                  requestedBackend: "fdm",
                  fdm: {
                    boundaryCorrection: ctx.draft.fdmBoundaryCorrection,
                    boundaryDeltaMin: String(ctx.draft.boundaryDeltaMinM),
                    boundaryPhiFloor: String(ctx.draft.boundaryPhiFloor),
                    commonCells: ctx.draft.fdmCommonCells,
                    commonCellsXy: ctx.draft.fdmCommonCellsXy,
                    defaultCell: ctx.draft.fdmDefaultCell,
                    demagExplain: ctx.draft.fdmDemagExplain,
                    demagMode: ctx.draft.fdmDemagMode,
                    demagStrategy: ctx.draft.fdmDemagStrategy,
                    perMagnet: ctx.draft.fdmPerMagnet,
                  },
                });
                if (!preview || preview.entries.length === 0) {
                  return (
                    <div className="text-xs text-fm-muted">
                      Enter a valid FDM default cell to preview mesh cell counts.
                    </div>
                  );
                }
                return (
                  <div className="grid gap-1 rounded border border-fm-border-subtle p-2 text-xs tabular-nums">
                    {preview.entries.map((entry) => (
                      <div
                        className="flex items-center justify-between gap-2"
                        key={entry.objectId}
                      >
                        <span className="font-mono">{entry.objectId}</span>
                        <span>
                          {entry.counts.join(" × ")} ({formatGridVector(entry.extent)} m)
                        </span>
                      </div>
                    ))}
                    <div className="flex items-center justify-between gap-2 border-t border-fm-border-subtle pt-1 font-medium">
                      <span>Total cells</span>
                      <span>{preview.totalCellCount.toLocaleString("en-US")}</span>
                    </div>
                    {onApplyFdmGrid ? (
                      <div className="pt-1">
                        <Button
                          size="sm"
                          type="button"
                          variant="secondary"
                          onClick={() => void onApplyFdmGrid()}
                        >
                          Apply FDM Grid
                        </Button>
                      </div>
                    ) : null}
                  </div>
                );
              },
            },
            {
              key: "fdmPerMagnet",
              label: "FDM per-magnet grids JSON",
              type: "expression",
              multiline: true,
              placeholder: '{"free":{"cell":[2e-9,2e-9,1e-9]}}',
              showWhen: (d) => isExplicitFdmDraft(d),
            },
            {
              key: "fdmCommonCells",
              label: "Common convolution cells (Nx, Ny, Nz)",
              type: "text",
              mono: true,
              showWhen: (d) => isExplicitFdmDraft(d),
            },
            {
              key: "fdmCommonCellsXy",
              label: "Common XY cells (Nx, Ny)",
              type: "text",
              mono: true,
              showWhen: (d) => isExplicitFdmDraft(d),
            },
            {
              key: "fdmDemagExplain",
              label: "Explain FDM demag plan",
              type: "switch",
              showWhen: (d) => isExplicitFdmDraft(d),
            },
            {
              key: "fdmBoundaryCorrection",
              label: "FDM boundary correction",
              type: "select",
              structural: true,
              showWhen: (d) => isExplicitFdmDraft(d),
              options: [
                { value: "engine_default", label: "Engine default" },
                { value: "none", label: "None — staircase" },
                { value: "volume", label: "Volume fraction T0" },
                { value: "full", label: "Surface + volume T1" },
              ],
            },
            {
              key: "boundaryPhiFloor",
              label: "Boundary volume floor",
              symbol: (
                <>
                  φ<sub>min</sub>
                </>
              ),
              type: "number",
              min: 0.001,
              max: 0.999,
              step: 0.01,
              showWhen: (d) =>
                isExplicitFdmDraft(d) &&
                (d.fdmBoundaryCorrection === "volume" || d.fdmBoundaryCorrection === "full"),
            },
            {
              key: "boundaryDeltaMinM",
              label: "Boundary intersection floor",
              symbol: (
                <>
                  δ<sub>min</sub>
                </>
              ),
              type: "quantity",
              units: LENGTH_UNITS_SI,
              defaultDisplayUnit: "nm",
              minExclusive: true,
              min: 0,
              showWhen: (d) => isExplicitFdmDraft(d) && d.fdmBoundaryCorrection === "full",
            },
            {
              key: "femDemagSolver",
              label: "FEM demag realization",
              type: "select",
              showWhen: (d) => d.demagEnabled && !isExplicitFdmDraft(d),
              options: [
                { value: "auto", label: "Auto" },
                { value: "poisson_robin", label: "Poisson Robin" },
                { value: "poisson_dirichlet", label: "Poisson Dirichlet" },
                { value: "fredkin_koehler", label: "Fredkin–Koehler" },
                { value: "bem", label: "BEM" },
                { value: "fmm", label: "FMM" },
                { value: "airbox_robin", label: "Airbox Robin" },
              ],
            },
            {
              key: "femDemagPolicyJson",
              label: "FEM demag solver policy JSON",
              type: "expression",
              multiline: true,
              placeholder: "{}",
              showWhen: (d) => !isExplicitFdmDraft(d),
            },
            {
              key: "externalFieldTesla",
              label: "External bias field",
              symbol: (
                <>
                  B<sub>ext</sub>
                </>
              ),
              type: "vector3",
              units: FIELD_TESLA_UNITS_SI,
              defaultDisplayUnit: "mT",
            },
          ],
        },
        {
          id: "default-solver",
          title: "Default Time & Relax Solver",
          icon: Timer,
          modeTabId: "physics",
          defaultOpen: false,
          summary: (d) => `${d.defaultIntegrator.toUpperCase()} · ${d.defaultRelaxAlgorithm}`,
          rows: [
            {
              key: "defaultIntegrator",
              label: "Default time integrator",
              type: "select",
              options: [
                { value: "auto", label: "Engine default (RK23)" },
                { value: "rk23", label: "RK23 Bogacki–Shampine" },
                { value: "rk45", label: "RK45 Dormand–Prince" },
                { value: "heun", label: "Heun / RK2" },
              ],
            },
            {
              key: "defaultTimestepMode",
              label: "Default timestep mode",
              type: "segmented",
              structural: true,
              options: [
                { value: "auto", label: "Auto" },
                { value: "adaptive_max_error", label: "Adaptive" },
                { value: "adaptive_advanced", label: "atol/rtol" },
                { value: "fixed", label: "Fixed dt" },
              ],
            },
            {
              key: "defaultFixedDtS",
              label: "Default fixed timestep",
              symbol: "Δt",
              type: "quantity",
              units: TIME_UNITS_SI,
              defaultDisplayUnit: "ps",
              min: 0,
              minExclusive: true,
              scrub: "log",
              showWhen: (d) => d.defaultTimestepMode === "fixed",
            },
            {
              key: "defaultDtInitS",
              label: "Initial timestep",
              symbol: (
                <>
                  Δt<sub>0</sub>
                </>
              ),
              type: "quantity",
              units: TIME_UNITS_SI,
              defaultDisplayUnit: "fs",
              min: 0,
              minExclusive: true,
              showWhen: (d) =>
                d.defaultTimestepMode === "adaptive_max_error" ||
                d.defaultTimestepMode === "adaptive_advanced",
            },
            {
              key: "defaultDtMinS",
              label: "Adaptive min dt",
              type: "quantity",
              units: TIME_UNITS_SI,
              defaultDisplayUnit: "fs",
              min: 0,
              minExclusive: true,
              showWhen: (d) =>
                d.defaultTimestepMode === "adaptive_max_error" ||
                d.defaultTimestepMode === "adaptive_advanced",
            },
            {
              key: "defaultDtMaxS",
              label: "Adaptive max dt",
              type: "quantity",
              units: TIME_UNITS_SI,
              defaultDisplayUnit: "ps",
              min: 0,
              minExclusive: true,
              showWhen: (d) =>
                d.defaultTimestepMode === "adaptive_max_error" ||
                d.defaultTimestepMode === "adaptive_advanced",
            },
            {
              key: "defaultMaxErr",
              label: "Maximum embedded vector error",
              type: "number",
              min: 1e-12,
              max: 1e-1,
              scrub: "log",
              showWhen: (d) => d.defaultTimestepMode === "adaptive_max_error",
            },
            {
              key: "defaultAtol",
              label: "Absolute tolerance (atol)",
              type: "number",
              min: 1e-15,
              max: 1e-2,
              scrub: "log",
              showWhen: (d) => d.defaultTimestepMode === "adaptive_advanced",
            },
            {
              key: "defaultRtol",
              label: "Relative tolerance (rtol)",
              type: "number",
              min: 1e-15,
              max: 1e-2,
              scrub: "log",
              showWhen: (d) => d.defaultTimestepMode === "adaptive_advanced",
            },
            {
              key: "defaultSafety",
              label: "Safety factor",
              type: "number",
              min: 0.1,
              max: 1,
              step: 0.05,
              showWhen: (d) => d.defaultTimestepMode === "adaptive_advanced",
            },
            {
              key: "defaultGrowthLimit",
              label: "Growth limit",
              type: "number",
              min: 1,
              max: 20,
              showWhen: (d) => d.defaultTimestepMode === "adaptive_advanced",
            },
            {
              key: "defaultShrinkLimit",
              label: "Shrink limit",
              type: "number",
              min: 0.01,
              max: 1,
              step: 0.05,
              showWhen: (d) => d.defaultTimestepMode === "adaptive_advanced",
            },
            {
              key: "defaultMaxSpinRotation",
              label: "Max spin rotation (optional)",
              type: "text",
              mono: true,
              showWhen: (d) => d.defaultTimestepMode === "adaptive_advanced",
            },
            {
              key: "defaultNormTolerance",
              label: "Norm tolerance (optional)",
              type: "text",
              mono: true,
              showWhen: (d) => d.defaultTimestepMode === "adaptive_advanced",
            },
            {
              key: "defaultDemagIntervalS",
              label: "Demag update interval",
              type: "quantity",
              units: TIME_UNITS_SI,
              defaultDisplayUnit: "ps",
              min: 0,
            },
            {
              key: "defaultRelaxAlgorithm",
              label: "Default relax method",
              type: "select",
              options: [
                { value: "llg_overdamped", label: "Damped LLG" },
                { value: "projected_gradient_bb", label: "LLG Projected Gradient BB" },
                { value: "nonlinear_cg", label: "Nonlinear Conjugate Gradient" },
              ],
            },
            {
              key: "defaultTorqueToleranceApm",
              label: "Default max |m × B| stop",
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
              key: "defaultEnergyToleranceJ",
              label: "Default energy tolerance",
              symbol: (
                <>
                  ε<sub>E</sub>
                </>
              ),
              type: "quantity",
              units: ENERGY_JOULE_UNITS_SI,
              defaultDisplayUnit: "J",
              min: 0,
              minExclusive: true,
              scrub: "log",
            },
            {
              key: "defaultMaxRelaxSteps",
              label: "Default max relax steps",
              type: "number",
              integer: true,
              min: 1,
            },
          ],
        },
        ...(canSubscribeResources && !testSnapshot
          ? [
              {
                id: "execution-runs-batches",
                title: "Execution Runs & Parameter Batches",
                icon: History,
                modeTabId: "hardware",
                defaultOpen: false,
                rows: [
                  {
                    type: "custom" as const,
                    wide: true,
                    render: () => (
                      <div className="grid gap-3">
                        <ProjectRunsSection />
                        <ProjectBatchesSection />
                      </div>
                    ),
                  },
                ],
              },
            ]
          : []),
      ],
      commitBar: {
        mode: "staged",
        confirmApply: (draft, base) =>
          draft.discretization !== base.discretization
            ? {
                title: `Switch discretization to ${draft.discretization.toUpperCase()}?`,
                description:
                  "Existing mesh or grid artifacts stay in session history, and the new discretization lane will be evaluated before computing.",
                confirmLabel: "Switch discretization",
              }
            : null,
        onApply: async (draft) => {
          if (onCommitExecution) {
            return onCommitExecution(draft);
          }
          return true;
        },
      },
    }),
    [
      baseline.executionProfileBound,
      canSubscribeResources,
      globalDraftForPreview,
      lastAuthoringError,
      onApplyFdmGrid,
      onApplyProfile,
      onCommitExecution,
      sceneData,
      stageDrafts,
      testSnapshot,
    ],
  );

  return <ConnectedInspectorSpec baseline={baseline} selection={selection} spec={spec} />;
}

/* ── 3. study.stages — StudyStagesInspectorPanel ────────────────────────── */

const DEFAULT_STAGE_ITEMS: readonly StudyStageSequenceItem[] = [
  {
    rowKey: "row-relax-1",
    stageId: "initial_relax",
    kind: "relax",
    label: "Relax",
    summary: "LLG Projected Gradient · τ ≤ 0.10 mT",
    durationBadge: "compute",
    enabled: true,
  },
  {
    rowKey: "row-drive-2",
    stageId: "k0_sinc",
    kind: "add_field_drive",
    label: "Add Field Drive",
    summary: "Sinc pulse · fc = 40 GHz · B₀ = 1 mT",
    durationBadge: "0 s",
    enabled: true,
  },
  {
    rowKey: "row-tbl-3",
    stageId: "tbl_clock",
    kind: "table_autosave",
    label: "Table Autosave",
    summary: "Explicit · Δt = 500 fs (f_Nyq = 1.00 THz)",
    durationBadge: "0 s",
    enabled: true,
  },
  {
    rowKey: "row-fft-4",
    stageId: "gamma_fft",
    kind: "fft_response",
    label: "FFT Response",
    summary: "Gamma (k = 0) · my · Hann + linear detrend",
    durationBadge: "0 s",
    enabled: true,
  },
  {
    rowKey: "row-run-5",
    stageId: "run_main",
    kind: "run",
    label: "Run",
    summary: "RK23 adaptive · t_end = 10.0 ns",
    durationBadge: "10 ns",
    enabled: true,
  },
];

function parseStagesDraftList(json: string): StudyStageSequenceItem[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (Array.isArray(parsed)) return parsed as StudyStageSequenceItem[];
  } catch {
    // Fallback
  }
  return [...DEFAULT_STAGE_ITEMS];
}

const STAGE_KIND_TITLES: Readonly<Record<string, string>> = {
  relax: "Relax",
  run: "Run",
  hysteresis: "Hysteresis",
  eigenmodes: "Eigenmodes",
  frequency_response: "Frequency Response",
  add_field_drive: "Add Field Drive",
  mask_field_drive: "Mask Field Drive",
  table_autosave: "Table Autosave",
  autosave: "Field Autosave",
  fft_response: "FFT Response",
  save_state: "Save State",
  change_device: "Change Device",
  antenna_field_solve: "Antenna Field Solve",
};

function stageSequenceItemFromDraft(
  draft: StudyStageDraft,
  idx: number,
): StudyStageSequenceItem {
  const computeKinds = new Set([
    "relax",
    "run",
    "hysteresis",
    "eigenmodes",
    "frequency_response",
  ]);
  const label = STAGE_KIND_TITLES[draft.kind] ?? draft.kind;
  const durationBadge =
    draft.kind === "run" && draft.untilSeconds
      ? `${draft.untilSeconds} s`
      : computeKinds.has(draft.kind)
        ? "compute"
        : "0 s";
  return {
    rowKey: draft.pipelineNodeId ?? draft.stageId ?? `stage-row-${idx}`,
    stageId: draft.stageId || `${draft.kind}_${idx + 1}`,
    kind: draft.kind,
    label,
    summary: `Stage ${idx + 1} · ${draft.stageId || draft.kind}`,
    durationBadge,
    enabled: draft.stageEnabled ?? draft.pipelineEnabled ?? true,
  };
}

export function StudyStagesInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  if (kernel) {
    return <ConnectedStudyStagesInspectorPanel selection={selection} />;
  }
  return (
    <StudyStagesInspectorPanelView
      items={DEFAULT_STAGE_ITEMS}
      selection={selection}
    />
  );
}

const KNOWN_STAGE_ROUTE_KINDS = new Set([
  "relax",
  "run",
  "hysteresis",
  "eigenmodes",
  "frequency_response",
  "add_field_drive",
  "mask_field_drive",
  "table_autosave",
  "autosave",
  "fft_response",
  "save_state",
  "change_device",
  "antenna_field_solve",
]);

function resolveStageInspectKind(kind: string): string {
  const normalized = kind.trim().toLowerCase();
  if (
    normalized === "add_mask_field_drive" ||
    normalized === "update_mask_field_drive"
  ) {
    return "study.stage.mask_field_drive";
  }
  if (KNOWN_STAGE_ROUTE_KINDS.has(normalized)) {
    return `study.stage.${normalized}`;
  }
  return "study.stage.action";
}

function ConnectedStudyStagesInspectorPanel({ selection }: InspectorPanelProps) {
  const {
    commitStageDraftList,
    executeStudyCommand,
    isCanonicalPipeline,
    lastAuthoringError,
    sceneData,
    stageDrafts,
  } = useKernelStudyAuthoring(selection);
  const { model: runtimeModel } = useKernelStudyRuntimeTelemetry(selection);
  const items = useMemo(
    () =>
      stageDrafts.map((d, idx) => {
        const base = stageSequenceItemFromDraft(d, idx);
        const liveStage = runtimeModel.stages[idx];
        return liveStage?.status && liveStage.status !== "not_started"
          ? { ...base, summary: `${base.summary} · ${liveStage.status}` }
          : base;
      }),
    [runtimeModel.stages, stageDrafts],
  );
  const profileBound = sceneData ? hasStudyExecutionProfile(sceneData) : false;
  return (
    <StudyStagesInspectorPanelView
      executionProfileBound={profileBound}
      isCanonicalPipeline={isCanonicalPipeline}
      items={items}
      lastAuthoringError={lastAuthoringError}
      selection={selection}
      stageDrafts={stageDrafts}
      onRunCommand={(cmd) => void executeStudyCommand(cmd)}
      onCommitSequence={async (nextItems) => {
        const nextDrafts = nextItems.map((item, idx) => {
          const existing = stageDrafts.find(
            (candidate) =>
              (candidate.pipelineNodeId ?? candidate.stageId) === item.rowKey ||
              candidate.stageId === item.stageId,
          );
          if (existing) {
            return {
              ...existing,
              stageId: item.stageId,
              stageEnabled: item.enabled,
            };
          }
          const copySource = stageDrafts.find(
            (candidate) =>
              item.rowKey.startsWith(`dup:${candidate.stageId}:`) ||
              item.rowKey.startsWith(
                `dup:${candidate.pipelineNodeId ?? candidate.stageId}:`,
              ),
          );
          if (copySource) {
            return {
              ...copySource,
              pipelineNodeId: undefined,
              stageId: item.stageId,
              stageEnabled: item.enabled,
            };
          }
          const created = createDefaultStudyStageDraft(
            item.kind as StudyStageDraftKind,
            idx,
          );
          return {
            ...created,
            stageId: item.stageId,
            stageEnabled: item.enabled,
          };
        });
        return commitStageDraftList(nextDrafts);
      }}
    />
  );
}

function StudyStagesInspectorPanelView({
  executionProfileBound = false,
  isCanonicalPipeline = false,
  items: sourceItems,
  lastAuthoringError = null,
  onCommitSequence,
  onRunCommand,
  selection,
  stageDrafts,
}: InspectorPanelProps & {
  executionProfileBound?: boolean;
  isCanonicalPipeline?: boolean;
  items: readonly StudyStageSequenceItem[];
  lastAuthoringError?: string | null;
  onCommitSequence?: (nextItems: StudyStageSequenceItem[]) => Promise<boolean>;
  onRunCommand?: (commandId: string) => void;
  stageDrafts?: readonly StudyStageDraft[];
}) {
  const workflowIssues = useMemo(
    () => (stageDrafts ? validateStudyWorkflow(stageDrafts) : []),
    [stageDrafts],
  );
  const cumulativeSummary = useMemo(() => {
    if (!stageDrafts) {
      return {
        drives: "k0_sinc (sinc_pulse, fc = 40.0 GHz)",
        clock: "Δt = 500 fs (f_Nyq = 1.00 THz)",
        fft: "Gamma (k = 0) FFT · my · Hann",
      };
    }
    const wf = resolveStudyWorkflowStateBefore(stageDrafts, stageDrafts.length);
    const activeDrives = stageDrafts
      .filter((d) => d.kind === "add_field_drive" && d.fieldDrive.enabled)
      .map((d) => `${d.fieldDrive.name || d.stageId} (${d.fieldDrive.waveform.kind})`);
    return {
      drives: activeDrives.length > 0 ? activeDrives.join(", ") : "None configured",
      clock: wf.tableAutosave
        ? `${wf.tableAutosave.samplePeriodS ?? "auto"} s (${wf.tableAutosave.sourceStageId})`
        : "OFF",
      fft: wf.fftResponse
        ? `${wf.fftResponse.analysis} · ${wf.fftResponse.responseComponent} (${wf.fftResponse.sourceStageId})`
        : "OFF",
    };
  }, [stageDrafts]);

  const baseline = useMemo<StudyStagesDraft>(() => {
    const computeKinds = new Set([
      "relax",
      "run",
      "hysteresis",
      "eigenmodes",
      "frequency_response",
    ]);
    const enabledCount = sourceItems.filter((s) => s.enabled).length;
    const computeCount = sourceItems.filter((s) => computeKinds.has(s.kind)).length;
    return {
      stagesJson: JSON.stringify(sourceItems),
      totalCount: sourceItems.length,
      enabledCount,
      computeCount,
      zeroDurationCount: sourceItems.length - computeCount,
    };
  }, [sourceItems]);

  const spec = useMemo<InspectorSpec<StudyStagesDraft>>(
    () => ({
      id: "study.stages",
      header: {
        breadcrumbs: studyBreadcrumbs("Stages"),
        canFitView: true,
      },
      identity: {
        domain: "study",
        icon: Workflow,
        title: () => "Stages",
        kindLabel: "Ordered study pipeline",
        entityId: "study:stages",
        statePill: (d) => {
          const items = parseStagesDraftList(d.stagesJson);
          return items.length > 0
            ? { tone: "ok", label: `${items.length} stages` }
            : { tone: "warn", label: "Empty" };
        },
      },
      facts: (d): readonly InspectorFact[] => {
        const items = parseStagesDraftList(d.stagesJson);
        const computeKinds = new Set([
          "relax",
          "run",
          "hysteresis",
          "eigenmodes",
          "frequency_response",
        ]);
        const enabled = items.filter((item) => item.enabled).length;
        const compute = items.filter((item) => computeKinds.has(item.kind)).length;
        return [
          { id: "total", label: "Total stages", value: String(items.length) },
          { id: "enabled", label: "Enabled", value: String(enabled) },
          { id: "compute", label: "Compute stages", value: String(compute) },
          { id: "zero", label: "0 s instructions", value: String(items.length - compute) },
        ];
      },
      notices: (): readonly InspectorNotice<StudyStagesDraft>[] => {
        const list: InspectorNotice<StudyStagesDraft>[] = [];
        if (lastAuthoringError) {
          list.push({
            id: "stages-authoring-err",
            tone: "err",
            text: lastAuthoringError,
          });
        }
        if (isCanonicalPipeline) {
          list.push({
            id: "canonical-pipeline-guard",
            tone: "info",
            text: "This study uses a canonical study_pipeline graph. Inspect individual stage nodes to edit parameters.",
          });
        }
        for (let i = 0; i < workflowIssues.length; i += 1) {
          const issue = workflowIssues[i]!;
          list.push({
            id: `wf-issue-${i}`,
            tone: issue.severity === "error" ? "err" : "warn",
            text: issue.message,
          });
        }
        return list;
      },
      sections: [
        {
          id: "stage-sequence",
          title: "Stage sequence",
          icon: Workflow,
          defaultOpen: true,
          summary: (d) => `${parseStagesDraftList(d.stagesJson).length} ordered stages`,
          rows: [
            {
              key: "stagesJson",
              type: "custom",
              wide: true,
              render: (ctx) => {
                const items = parseStagesDraftList(ctx.draft.stagesJson);
                const commitItems = (next: StudyStageSequenceItem[]) => {
                  ctx.setField("stagesJson", JSON.stringify(next));
                };
                const move = (idx: number, dir: -1 | 1) => {
                  const target = idx + dir;
                  if (target < 0 || target >= items.length) return;
                  const copy = [...items];
                  const tmp = copy[idx]!;
                  copy[idx] = copy[target]!;
                  copy[target] = tmp;
                  commitItems(copy);
                };
                const duplicate = (idx: number) => {
                  const src = items[idx];
                  if (!src || src.kind === "antenna_field_solve") return;
                  const copyId = `${src.stageId}_copy_${items.length + 1}`;
                  const next = [...items];
                  next.splice(idx + 1, 0, {
                    ...src,
                    rowKey: `dup:${src.rowKey}:${Date.now()}`,
                    stageId: copyId,
                  });
                  commitItems(next);
                };
                const addStage = (kind: string, label: string, durationBadge: string) => {
                  const n = items.length + 1;
                  commitItems([
                    ...items,
                    {
                      rowKey: `row-${kind}-${Date.now()}-${n}`,
                      stageId: `${kind}_${n}`,
                      kind,
                      label,
                      summary: `Configured ${label.toLowerCase()} stage`,
                      durationBadge,
                      enabled: true,
                    },
                  ]);
                };

                return (
                  <div className="fm-region-precedence-list">
                    <div className="fm-inspector-notice__actions">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            disabled={isCanonicalPipeline}
                            size="sm"
                            type="button"
                            variant="secondary"
                          >
                            <Plus aria-hidden="true" size={14} />
                            <span>Add Stage</span>
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start">
                          <DropdownMenuLabel>Equilibrium &amp; Dynamics</DropdownMenuLabel>
                          <DropdownMenuGroup>
                            <DropdownMenuItem
                              onSelect={() => addStage("relax", "Relax", "compute")}
                            >
                              Relaxation
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={() => addStage("run", "Run", "10 ns")}
                            >
                              Time Evolution Run
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={() =>
                                addStage("hysteresis", "Hysteresis", "sweep")
                              }
                            >
                              Hysteresis Loop
                            </DropdownMenuItem>
                          </DropdownMenuGroup>
                          <DropdownMenuSeparator />
                          <DropdownMenuLabel>Linearized Spectra</DropdownMenuLabel>
                          <DropdownMenuGroup>
                            <DropdownMenuItem
                              onSelect={() =>
                                addStage("eigenmodes", "Eigenmodes", "modal")
                              }
                            >
                              Eigenmodes
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={() =>
                                addStage(
                                  "frequency_response",
                                  "Frequency Response",
                                  "sweep",
                                )
                              }
                            >
                              Driven Frequency Response
                            </DropdownMenuItem>
                          </DropdownMenuGroup>
                          <DropdownMenuSeparator />
                          <DropdownMenuLabel>0 s Pipeline Instructions</DropdownMenuLabel>
                          <DropdownMenuGroup>
                            <DropdownMenuItem
                              onSelect={() =>
                                addStage("add_field_drive", "Add Field Drive", "0 s")
                              }
                            >
                              Add Regional Field Drive
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={() =>
                                addStage("table_autosave", "Table Autosave", "0 s")
                              }
                            >
                              Table Autosave Clock
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={() =>
                                addStage("autosave", "Field Autosave", "0 s")
                              }
                            >
                              Field / Scalar Autosave
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={() =>
                                addStage("fft_response", "FFT Response", "0 s")
                              }
                            >
                              Spin-Wave FFT Response
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={() =>
                                addStage("save_state", "Save State", "0 s")
                              }
                            >
                              Save State Snapshot
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              disabled={executionProfileBound}
                              onSelect={() =>
                                addStage("change_device", "Change Device", "0 s")
                              }
                            >
                              Change Execution Device
                            </DropdownMenuItem>
                          </DropdownMenuGroup>
                        </DropdownMenuContent>
                      </DropdownMenu>

                      {onRunCommand ? (
                        <>
                          <Button
                            size="sm"
                            type="button"
                            variant="ghost"
                            onClick={() => onRunCommand("study.compute-observables")}
                          >
                            <Gauge aria-hidden="true" size={13} />
                            <span>Observables</span>
                          </Button>
                          <Button
                            size="sm"
                            type="button"
                            variant="ghost"
                            onClick={() => onRunCommand("study.compute-energies")}
                          >
                            <Sigma aria-hidden="true" size={13} />
                            <span>Energies</span>
                          </Button>
                        </>
                      ) : null}
                    </div>

                    {items.map((item, idx) => (
                      <div key={item.rowKey} className="fm-region-precedence-card">
                        <span aria-hidden="true" className="fm-stage-drag-handle">
                          <GripVertical size={14} />
                        </span>
                        <span className="fm-region-precedence-card__rank">{idx + 1}</span>
                        <div className="fm-region-precedence-card__body">
                          <div className="fm-region-precedence-card__title">
                            {item.label} <Badge>{item.durationBadge}</Badge>
                          </div>
                          <div className="fm-region-precedence-card__meta">{item.summary}</div>
                        </div>
                        <div className="fm-inspector-header-actions">
                          <Switch
                            aria-label={`Include ${item.label} in study`}
                            checked={item.enabled}
                            disabled={isCanonicalPipeline}
                            onCheckedChange={(checked) =>
                              commitItems(
                                items.map((entry, i) =>
                                  i === idx ? { ...entry, enabled: checked } : entry,
                                ),
                              )
                            }
                          />
                          <Button
                            aria-label={`Duplicate ${item.label}`}
                            disabled={
                              isCanonicalPipeline ||
                              item.kind === "antenna_field_solve"
                            }
                            size="icon"
                            type="button"
                            variant="ghost"
                            onClick={() => duplicate(idx)}
                          >
                            <Copy aria-hidden="true" size={14} />
                          </Button>
                          <Button
                            aria-label={`Move ${item.label} up`}
                            disabled={isCanonicalPipeline || idx === 0}
                            size="icon"
                            type="button"
                            variant="ghost"
                            onClick={() => move(idx, -1)}
                          >
                            <ArrowUp aria-hidden="true" size={14} />
                          </Button>
                          <Button
                            aria-label={`Move ${item.label} down`}
                            disabled={
                              isCanonicalPipeline || idx === items.length - 1
                            }
                            size="icon"
                            type="button"
                            variant="ghost"
                            onClick={() => move(idx, 1)}
                          >
                            <ArrowDown aria-hidden="true" size={14} />
                          </Button>
                          <Button
                            size="sm"
                            type="button"
                            variant="ghost"
                            onClick={() =>
                              ctx.selectNode({
                                kind: resolveStageInspectKind(item.kind),
                                label: `${item.label} ${idx + 1}`,
                                nodeId: `model:study:stages:stage:${item.stageId}`,
                                objectId: null,
                                ref: {
                                  kind: "study.stage.action",
                                  nodeId: `model:study:stages:stage:${item.stageId}`,
                                  stageId: item.stageId,
                                  stageIndex: idx,
                                  type: "study-stage",
                                },
                              })
                            }
                          >
                            Inspect →
                          </Button>
                          <Button
                            aria-label={`Remove ${item.label}`}
                            disabled={isCanonicalPipeline}
                            size="icon"
                            type="button"
                            variant="ghost"
                            onClick={() =>
                              commitItems(items.filter((_, i) => i !== idx))
                            }
                          >
                            <Trash2 aria-hidden="true" size={14} />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                );
              },
            },
          ],
        },
        {
          id: "cumulative-state",
          title: "Cumulative workflow state",
          icon: Layers,
          defaultOpen: false,
          summary: () => `${cumulativeSummary.clock} · FFT ${cumulativeSummary.fft}`,
          rows: [
            {
              label: "Active drives at end",
              type: "readonly",
              format: () => cumulativeSummary.drives,
            },
            {
              label: "Table sampling clock",
              type: "readonly",
              format: () => cumulativeSummary.clock,
            },
            {
              label: "Spectral postprocessing",
              type: "readonly",
              format: () => cumulativeSummary.fft,
            },
          ],
        },
      ],
      commitBar: {
        mode: isCanonicalPipeline ? "readOnly" : "staged",
        onApply: async (draft) => {
          if (onCommitSequence) {
            return onCommitSequence(parseStagesDraftList(draft.stagesJson));
          }
          return true;
        },
      },
    }),
    [
      cumulativeSummary,
      executionProfileBound,
      isCanonicalPipeline,
      lastAuthoringError,
      onCommitSequence,
      onRunCommand,
      workflowIssues,
    ],
  );

  return <ConnectedInspectorSpec baseline={baseline} selection={selection} spec={spec} />;
}

/* ── 4. study.recovery — StudyRecoveryInspectorPanel ────────────────────── */

export function StudyRecoveryInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  if (kernel) {
    return <ConnectedStudyRecoveryInspectorPanel selection={selection} />;
  }
  return <StudyRecoveryInspectorPanelView rawCheckpoints={[]} selection={selection} />;
}

const EMPTY_CHECKPOINTS: CheckpointEntry[] = [];

function ConnectedStudyRecoveryInspectorPanel({
  selection,
}: InspectorPanelProps) {
  const { executeStudyCommand } = useKernelStudyAuthoring(selection);
  const { checkpoints, energyHistory, solverEnergy, solverStatus } =
    useKernelStudyRecoveryResources();
  const rawList = checkpoints.data?.checkpoints ?? EMPTY_CHECKPOINTS;

  const hydrated = useMemo<StudyRecoveryDraft>(() => {
    const items: StudyCheckpointItem[] = rawList.map((entry, idx) => {
      const rec = entry as unknown as Record<string, unknown>;
      const id =
        typeof rec.checkpoint_id === "string"
          ? rec.checkpoint_id
          : typeof rec.id === "string"
            ? rec.id
            : `ckpt-${idx + 1}`;
      const step =
        typeof rec.step === "number" ? `Step ${rec.step}` : "Saved state";
      const resumeClass =
        typeof rec.resume_class === "string" ? rec.resume_class : "exact_state";
      const sourceLabel =
        typeof rec.source === "string" && rec.source ? rec.source : null;
      const stageId =
        typeof rec.stage_id === "string" && rec.stage_id ? rec.stage_id : null;
      return { id, stepLabel: step, resumeClass, sourceLabel, stageId };
    });
    const energyData = solverEnergy.data;
    const totalEnergyJ =
      typeof energyData?.total === "number" && Number.isFinite(energyData.total)
        ? energyData.total
        : null;
    const zeemanEnergyJ =
      typeof energyData?.zeeman === "number" &&
      Number.isFinite(energyData.zeeman)
        ? energyData.zeeman
        : null;
    const statusData = solverStatus.data;
    const runtimeState =
      typeof statusData?.runtime_state === "string"
        ? statusData.runtime_state.toLowerCase()
        : "";
    const latestStepNum =
      typeof statusData?.step_index === "number" &&
      Number.isFinite(statusData.step_index)
        ? String(statusData.step_index)
        : typeof energyData?.step === "number" &&
            Number.isFinite(energyData.step)
          ? String(energyData.step)
          : null;
    const historyData = energyHistory.data;
    const historyRows = Array.isArray(historyData?.rows)
      ? historyData.rows
      : null;
    const returnedRows =
      typeof historyData?.returned_rows === "number" &&
      Number.isFinite(historyData.returned_rows)
        ? historyData.returned_rows
        : historyRows
          ? historyRows.length
          : totalEnergyJ !== null
            ? 1
            : 0;
    const totalRows =
      typeof historyData?.total_rows === "number" &&
      Number.isFinite(historyData.total_rows)
        ? historyData.total_rows
        : returnedRows;
    const lastRow = historyRows?.at(-1) ?? null;
    const prevRow =
      historyRows && historyRows.length >= 2
        ? historyRows.at(-2) ?? null
        : null;
    let latestDeDt: string | null = null;
    if (
      lastRow &&
      prevRow &&
      typeof lastRow.total === "number" &&
      typeof prevRow.total === "number" &&
      typeof lastRow.time_seconds === "number" &&
      typeof prevRow.time_seconds === "number" &&
      Number.isFinite(lastRow.total) &&
      Number.isFinite(prevRow.total) &&
      Number.isFinite(lastRow.time_seconds) &&
      Number.isFinite(prevRow.time_seconds)
    ) {
      const dt = lastRow.time_seconds - prevRow.time_seconds;
      if (dt > 0) {
        const deDt = (lastRow.total - prevRow.total) / dt;
        if (Number.isFinite(deDt)) {
          latestDeDt = `${deDt.toExponential(3)} J/s`;
        }
      }
    }
    const latestRhsNorm =
      typeof statusData?.max_rhs_norm_per_s === "number" &&
      Number.isFinite(statusData.max_rhs_norm_per_s)
        ? `${statusData.max_rhs_norm_per_s.toExponential(3)} 1/s`
        : null;

    return {
      checkpoints: items,
      latestStep: latestStepNum ?? items[0]?.stepLabel ?? null,
      resumeClass: items[0]?.resumeClass ?? null,
      energyRows: returnedRows,
      totalEnergyRows: totalRows,
      totalEnergyJ,
      zeemanEnergyJ,
      latestDeDt,
      latestRhsNorm,
      hasPausedState: runtimeState === "paused",
      importFormat: "fms",
      exportFormat: "fms",
    };
  }, [energyHistory.data, rawList, solverEnergy.data, solverStatus.data]);

  return (
    <StudyRecoveryInspectorPanelView
      executeStudyCommand={executeStudyCommand}
      hydratedBaseline={hydrated}
      rawCheckpoints={rawList}
      selection={selection}
    />
  );
}

function StudyRecoveryInspectorPanelView({
  executeStudyCommand,
  hydratedBaseline,
  rawCheckpoints,
  selection,
}: InspectorPanelProps & {
  executeStudyCommand?: (commandId: string, input?: Record<string, unknown>) => Promise<void>;
  hydratedBaseline?: StudyRecoveryDraft;
  rawCheckpoints: CheckpointEntry[];
}) {
  const kernel = useContext(KernelContext);
  const runRecoveryCommand = useCallback(
    async (commandId: string, input?: Record<string, unknown>) => {
      if (executeStudyCommand) {
        await executeStudyCommand(commandId, input);
        return;
      }
      if (kernel) {
        await kernel.commands.execute(
          commandId,
          buildStudyCommandContext(kernel),
          input,
        );
      }
    },
    [executeStudyCommand, kernel],
  );
  const [restoreDialogOpen, setRestoreDialogOpen] = useState(false);
  const [selectedRestoreId, setSelectedRestoreId] = useState<string | null>(null);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importFileName, setImportFileName] = useState<string | null>(null);
  const [importBase64, setImportBase64] = useState<string | null>(null);
  const [importInspecting, setImportInspecting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importInspection, setImportInspection] =
    useState<SessionImportInspectResponse["inspection"] | null>(null);
  const [restoreMode, setRestoreMode] = useState("resume");

  const handleInspectFile = useCallback(
    async (file: File | null) => {
      setImportFileName(file?.name ?? null);
      setImportError(null);
      setImportInspection(null);
      setImportBase64(null);
      if (!file || !kernel) return;
      setImportInspecting(true);
      try {
        const b64 = await readFileAsBase64(file);
        const res = await kernel.api.persistence.imports.inspect({
          fms_base64: b64,
        });
        setImportBase64(b64);
        setImportInspection(res.inspection);
      } catch (err) {
        setImportError(
          err instanceof Error ? err.message : "Failed to inspect .fms archive.",
        );
      } finally {
        setImportInspecting(false);
      }
    },
    [kernel],
  );

  const fallbackBaseline = useMemo<StudyRecoveryDraft>(
    () => ({
      checkpoints: [],
      latestStep: null,
      resumeClass: null,
      energyRows: 0,
      totalEnergyRows: 0,
      totalEnergyJ: null,
      zeemanEnergyJ: null,
      latestDeDt: null,
      latestRhsNorm: null,
      hasPausedState: false,
      importFormat: "fms",
      exportFormat: "fms",
    }),
    [],
  );
  const baseline = hydratedBaseline ?? fallbackBaseline;

  const spec = useMemo<InspectorSpec<StudyRecoveryDraft>>(
    () => ({
      id: "study.recovery",
      header: {
        breadcrumbs: studyBreadcrumbs("Recovery"),
        canFitView: true,
        primaryHeaderAction: {
          label: "Save Checkpoint",
          icon: Database,
          onRun: async (ctx) => {
            if (kernel) {
              await runRecoveryCommand("study.save-checkpoint");
            } else {
              ctx.notify("Checkpoint requested", PERSISTENCE_CHECKPOINTS_PATH);
            }
          },
        },
      },
      identity: {
        domain: "study",
        icon: History,
        title: () => "Recovery",
        kindLabel: "Checkpoints & state restoration",
        entityId: "study:recovery",
        statePill: (d) =>
          d.checkpoints.length > 0
            ? { tone: "ok", label: `${d.checkpoints.length} checkpoints` }
            : d.hasPausedState
              ? { tone: "warn", label: "Paused state held" }
              : { tone: "neutral", label: "No checkpoints" },
      },
      facts: (d): readonly InspectorFact[] => [
        { id: "count", label: "Checkpoints", value: String(d.checkpoints.length) },
        { id: "step", label: "Latest step", value: d.latestStep },
        { id: "class", label: "Resume class", value: d.resumeClass },
        {
          id: "rows",
          label: "Energy rows",
          value: d.energyRows > 0 ? d.energyRows.toLocaleString("en-US") : null,
        },
      ],
      notices: (d) =>
        d.hasPausedState
          ? [
              {
                id: "paused-state",
                tone: "warn",
                text: "A paused runtime solver buffer is currently held in memory.",
                quickFix: {
                  label: "Resume Run",
                  onApply: (ctx) => {
                    if (kernel) {
                      void runRecoveryCommand("study.resume");
                    } else {
                      ctx.notify("Resuming study run");
                    }
                  },
                },
              },
            ]
          : [],
      sections: [
        {
          id: "saved-checkpoints",
          title: "Saved checkpoints",
          icon: Database,
          defaultOpen: true,
          summary: (d) =>
            d.checkpoints.length > 0
              ? `${d.checkpoints.length} saved`
              : "No checkpoints saved yet",
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <div className="grid gap-2">
                  {ctx.draft.checkpoints.length === 0 ? (
                    <EmptyState
                      description="Checkpoints are created automatically after completed stages or manually via Save Checkpoint."
                      heading="No checkpoints saved yet"
                    />
                  ) : (
                    <div className="fm-region-precedence-list">
                      {ctx.draft.checkpoints.map((ckpt) => (
                        <div key={ckpt.id} className="fm-field-layer-row">
                          <div>
                            <div className="fm-field-layer-row__label">{ckpt.id}</div>
                            <div className="fm-field-layer-row__meta">
                              {[
                                ckpt.stepLabel,
                                ckpt.resumeClass,
                                ckpt.stageId ? `stage ${ckpt.stageId}` : null,
                                ckpt.sourceLabel,
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                            </div>
                          </div>
                          <div className="flex items-center gap-1">
                            <Button
                              size="sm"
                              type="button"
                              variant="secondary"
                              onClick={() => {
                                if (kernel && rawCheckpoints.length > 0) {
                                  setSelectedRestoreId(ckpt.id);
                                  setRestoreDialogOpen(true);
                                } else if (kernel) {
                                  void runRecoveryCommand(
                                    "study.restore-checkpoint",
                                    { checkpointId: ckpt.id, checkpoint_id: ckpt.id },
                                  );
                                } else {
                                  ctx.notify("Restoring checkpoint", ckpt.id);
                                }
                              }}
                            >
                              <RotateCcw aria-hidden="true" size={13} />
                              <span>Restore…</span>
                            </Button>
                            <Button
                              aria-label={`Discard checkpoint ${ckpt.id}`}
                              size="sm"
                              type="button"
                              variant="ghost"
                              onClick={() => {
                                if (kernel) {
                                  void runRecoveryCommand(
                                    "study.discard-checkpoint",
                                    { checkpointId: ckpt.id, checkpoint_id: ckpt.id },
                                  );
                                } else {
                                  ctx.notify("Discarding checkpoint", ckpt.id);
                                }
                              }}
                            >
                              <Trash2 aria-hidden="true" size={13} />
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="flex flex-wrap gap-1.5">
                    <Button
                      size="sm"
                      type="button"
                      variant="secondary"
                      onClick={() => {
                        if (kernel) {
                          void runRecoveryCommand("study.save-checkpoint");
                        } else {
                          ctx.notify("Saving checkpoint");
                        }
                      }}
                    >
                      <Database aria-hidden="true" size={13} />
                      <span>Save</span>
                    </Button>
                    <Button
                      disabled={ctx.draft.checkpoints.length === 0}
                      size="sm"
                      type="button"
                      variant="secondary"
                      onClick={() => {
                        setSelectedRestoreId(ctx.draft.checkpoints[0]?.id ?? null);
                        setRestoreDialogOpen(true);
                      }}
                    >
                      <RotateCcw aria-hidden="true" size={13} />
                      <span>Restore dialog…</span>
                    </Button>
                    <Button
                      size="sm"
                      type="button"
                      variant="danger"
                      onClick={() => {
                        if (kernel) {
                          void runRecoveryCommand("study.discard-paused-state");
                        } else {
                          ctx.notify("Discarding paused state");
                        }
                      }}
                    >
                      <Scissors aria-hidden="true" size={13} />
                      <span>Discard paused state</span>
                    </Button>
                  </div>
                </div>
              ),
            },
          ],
        },
        {
          id: "state-import-export",
          title: "State import & export",
          icon: FileOutput,
          defaultOpen: true,
          rows: [
            {
              key: "importFormat",
              label: "Import format",
              type: "segmented",
              options: [
                { value: "fms", label: "Fullmag (.fms)" },
                { value: "ovf", label: "OVF 2.0 (.ovf)" },
                { value: "npz", label: "NumPy (.npz)" },
              ],
            },
            {
              label: "Import external state",
              type: "custom",
              render: (ctx) => (
                <Button
                  size="sm"
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    if (kernel) {
                      setImportDialogOpen(true);
                    } else {
                      ctx.notify("Field state import inspection ready");
                    }
                  }}
                >
                  <Upload aria-hidden="true" size={13} />
                  <span>Import .{ctx.draft.importFormat} state…</span>
                </Button>
              ),
            },
            {
              key: "exportFormat",
              label: "Export format",
              type: "select",
              options: [
                { value: "fms", label: "Fullmag state (.fms)" },
                { value: "ovf", label: "OVF 2.0 binary (.ovf)" },
                { value: "zarr", label: "Zarr v3 snapshot (.zarr.zip)" },
              ],
            },
            {
              label: "Export current state",
              type: "custom",
              render: (ctx) => (
                <Button
                  size="sm"
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    if (kernel) {
                      void runRecoveryCommand("study.export-state", {
                        format: ctx.draft.exportFormat,
                      });
                    } else {
                      ctx.notify(`Exporting .${ctx.draft.exportFormat} snapshot`);
                    }
                  }}
                >
                  <Download aria-hidden="true" size={13} />
                  <span>Export snapshot…</span>
                </Button>
              ),
            },
          ],
        },
        {
          id: "energy-ledger",
          title: "Run History & Energy Ledger",
          icon: Activity,
          defaultOpen: false,
          rows: [
            {
              label: "Returned energy rows",
              type: "readonly",
              format: (d) =>
                d.energyRows > 0
                  ? `${d.energyRows.toLocaleString("en-US")} of ${d.totalEnergyRows.toLocaleString("en-US")} rows`
                  : "Not computed yet",
            },
            {
              label: "Total energy E_tot",
              type: "readonly",
              format: (d) =>
                d.totalEnergyJ !== null
                  ? `${d.totalEnergyJ.toExponential(4)} J`
                  : "Not computed yet",
            },
            {
              label: "Zeeman energy E_Z",
              type: "readonly",
              format: (d) =>
                d.zeemanEnergyJ !== null
                  ? `${d.zeemanEnergyJ.toExponential(4)} J`
                  : "—",
            },
            {
              label: "Latest dE/dt",
              type: "readonly",
              format: (d) => d.latestDeDt ?? "—",
            },
            {
              label: "Latest RHS norm",
              type: "readonly",
              format: (d) => d.latestRhsNorm ?? "—",
            },
          ],
        },
      ],
      details: () => [
        { label: "Checkpoints URI", value: PERSISTENCE_CHECKPOINTS_PATH, mono: true },
        { label: "Import formats", value: ".fms, .ovf, .npz", mono: true },
      ],
      commitBar: {
        mode: "immediate",
        statusMessage: () => "Recovery actions execute immediately with confirmation",
      },
    }),
    [kernel, rawCheckpoints.length, runRecoveryCommand],
  );

  return (
    <>
      <ConnectedInspectorSpec baseline={baseline} selection={selection} spec={spec} />
      <RestoreCheckpointDialog
        checkpoints={rawCheckpoints}
        open={restoreDialogOpen}
        selectedCheckpointId={selectedRestoreId}
        onConfirm={(checkpointId) => {
          setRestoreDialogOpen(false);
          if (kernel) {
            void runRecoveryCommand("study.restore-checkpoint", {
              checkpoint_id: checkpointId,
              checkpointId,
            });
          }
        }}
        onOpenChange={setRestoreDialogOpen}
        onSelectCheckpoint={setSelectedRestoreId}
      />
      <ImportStateDialog
        error={importError}
        fileName={importFileName}
        inspecting={importInspecting}
        inspection={importInspection}
        open={importDialogOpen}
        restoreMode={restoreMode}
        onConfirm={() => {
          setImportDialogOpen(false);
          if (kernel && importBase64) {
            void runRecoveryCommand("study.import-state", {
              fms_base64: importBase64,
              restore_mode: restoreMode,
            });
          }
        }}
        onFileSelected={(file) => void handleInspectFile(file)}
        onOpenChange={setImportDialogOpen}
        onRestoreModeChange={setRestoreMode}
      />
    </>
  );
}

export { Info };
