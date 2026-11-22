import type { Selection } from "@/kernel/selection/selectionTypes";

import { isExplicitFdmStudy } from "../../panels/StudyGlobalAuthoringModel";
import type { StudyStageDraft } from "../../panels/StudyStageAuthoringModel";
import type { PipelineStripStep } from "../../panels/study/ConnectedInspectorSpec";
export const STUDY_SESSION_DISCRETIZATION_LOCKED_HINT =
  "Assigned by the session simulation mode" as const;

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

export interface StudyRootDraft {
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

export interface StudyExecutionDraft {
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

export function resolveLockedSessionDiscretization(
  draft: Pick<StudyExecutionDraft, "discretization" | "sessionDiscretization">,
): "fdm" | "fem" | null {
  if (
    draft.sessionDiscretization === "fem" ||
    draft.sessionDiscretization === "fdm"
  ) {
    return draft.sessionDiscretization;
  }
  if (draft.discretization === "fem" || draft.discretization === "fdm") {
    return draft.discretization;
  }
  return null;
}

export function isExplicitFdmDraft(draft: StudyExecutionDraft): boolean {
  return isExplicitFdmStudy({
    requestedBackend: draft.executionProfileBound ? null : draft.discretization,
    requestedDiscretization: draft.requestedDiscretization,
    sessionDiscretization: draft.sessionDiscretization,
  });
}

export interface StudyStageSequenceItem {
  readonly rowKey: string;
  readonly stageId: string;
  readonly kind: string;
  readonly label: string;
  readonly summary: string;
  readonly durationBadge: string;
  readonly enabled: boolean;
}

export interface StudyStagesDraft {
  stagesJson: string;
  totalCount: number;
  enabledCount: number;
  computeCount: number;
  zeroDurationCount: number;
}

export interface StudyCheckpointItem {
  readonly id: string;
  readonly stepLabel: string;
  readonly resumeClass: string;
  readonly sourceLabel: string | null;
  readonly stageId: string | null;
}

export interface StudyRecoveryDraft {
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

export const DEFAULT_PIPELINE_STEPS: readonly PipelineStripStep[] = [
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

export function studyBreadcrumbs(leafLabel?: string): readonly {
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

export function resolveEffectiveDeviceDisplay(draft: StudyExecutionDraft): {
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

export function hasSubscribableResourceStore(kernel: unknown): boolean {
  return (
    typeof (
      kernel as { resources?: { subscribe?: unknown } } | null | undefined
    )?.resources?.subscribe === "function"
  );
}

export function cleanProvenanceToken(value: string | null | undefined): string | null {
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

export function parseVector3Text(
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

export const DEFAULT_STAGE_ITEMS: readonly StudyStageSequenceItem[] = [
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

export function parseStagesDraftList(json: string): StudyStageSequenceItem[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (Array.isArray(parsed)) return parsed as StudyStageSequenceItem[];
  } catch {
    // Fallback
  }
  return [...DEFAULT_STAGE_ITEMS];
}

export const STAGE_KIND_TITLES: Readonly<Record<string, string>> = {
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

export function stageSequenceItemFromDraft(
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

export const KNOWN_STAGE_ROUTE_KINDS = new Set([
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

export function resolveStageInspectKind(kind: string): string {
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
