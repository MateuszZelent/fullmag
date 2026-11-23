import type { JsonValue } from "@/kernel/api/apiTypes";
import type {
  ActiveLaneCapabilitySnapshot,
} from "@/kernel/resources/useActiveLaneCapabilities";
import type { Selection } from "@/kernel/selection/selectionTypes";

import type { StageAutosaveDraft } from "../../../panels/StageAutosaveDraft";
import {
  createDefaultStudyStageDraft,
  type StudyStageDraft,
} from "../../../panels/StudyStageAuthoringModel";
import type { PipelineStripStep } from "../../../panels/study/ConnectedInspectorSpec";
import { serializeStageEnabled } from "../../../panels/stages/StageSharedControls";
import type {
  EffectiveStudyAutosaveOutput,
  EffectiveStudyTableAutosave,
} from "../../../panels/stages/studyWorkflowState";
export interface StageValidationContext {
  activeLane?: ActiveLaneCapabilitySnapshot | null;
  algorithmsAvailable?: readonly string[];
  backend: string;
  demagEnabled: boolean;
  device: string;
  mode: string;
  precision: string;
}

export function stageBreadcrumbs(stageTitle: string): readonly {
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

export function resolveStageMeta(selection: Selection, defaultPrefix: string) {
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

export function fallbackPipelineSteps(
  stageId: string,
  index: number,
  kind: string,
  label: string,
): readonly PipelineStripStep[] {
  return [{ id: stageId, index, kind, label, status: "ready" }];
}

/* ── 1. study.stage.relax — RelaxStageInspectorPanel ────────────────────── */

export interface RelaxStageDraft {
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

export const DEFAULT_RELAX_AUTOSAVE: StageAutosaveDraft =
  createDefaultStudyStageDraft("relax", 0).stageAutosave;
export const DEFAULT_RUN_AUTOSAVE: StageAutosaveDraft =
  createDefaultStudyStageDraft("run", 0).stageAutosave;

export function toRelaxStudyStageDraft(
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

export interface RunStageDraft {
  stageId: string;
  stageEnabled: boolean;
  untilSeconds: number;
  legacyRunFixedTimestep: string;
  stageAutosave: StageAutosaveDraft;
  stageMagnetizationAssignments: JsonValue | undefined;
}

export interface RunWorkflowDisplayInfo {
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

export {
  DEFAULT_CANONICAL_K_PATH,
  formatKPathWithSamples,
  parseExplicitFrequencySweepHz,
  parseKPathSamplesPerSegment,
  SUPPORTED_FREQUENCY_RESPONSE_SOLVER_METHODS,
  type FrequencyResponseSolverMethod,
  type SpectralStageTestSnapshot,
} from "./spectralStageShared";
