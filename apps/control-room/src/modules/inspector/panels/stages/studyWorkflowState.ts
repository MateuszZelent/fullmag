import {
  resolveAutoSincSampling,
  type AutoSincSamplingResult,
} from "@/shared/domain/physics/autoSampling";

import type { StudyStageDraft } from "../StudyStageAuthoringModel";

export interface EffectiveStudyTableAutosave {
  autoSampling: AutoSincSamplingResult | null;
  quantities: readonly string[];
  samplePeriodS: number | null;
  samplingMode: "explicit" | "auto_sinc_cutoff";
  sourceDriveIds: readonly string[];
  sourceStageId: string;
}

export interface EffectiveStudyAutosaveOutput {
  autoSampling: AutoSincSamplingResult | null;
  everySeconds: number | null;
  outputKind: "field" | "scalar";
  quantity: string;
  samplingMode: "explicit" | "auto_sinc_cutoff";
  sourceDriveIds: readonly string[];
  sourceStageId: string;
}

export interface EffectiveStudyFftResponse {
  detrend: "none" | "mean" | "linear";
  responseComponent: "my" | "mz";
  sourceStageId: string;
  susceptibilityFloorFraction: number;
  window: "hann";
}

export interface EffectiveStudyWorkflowState {
  fftResponse: EffectiveStudyFftResponse | null;
  outputs: EffectiveStudyAutosaveOutput[];
  tableAutosave: EffectiveStudyTableAutosave | null;
}

export interface StudyWorkflowValidationIssue {
  index: number;
  message: string;
  severity: "error" | "warning";
}

export function resolveStudyWorkflowStateBefore(
  drafts: readonly StudyStageDraft[],
  beforeIndex: number,
): EffectiveStudyWorkflowState {
  let tableAutosave: EffectiveStudyTableAutosave | null = null;
  let fftResponse: EffectiveStudyFftResponse | null = null;
  const outputs = new Map<string, EffectiveStudyAutosaveOutput>();
  const limit = Math.max(0, Math.min(beforeIndex, drafts.length));
  const autoContext = automaticSamplingContext(drafts, beforeIndex);

  for (let index = 0; index < limit; index += 1) {
    const draft = drafts[index];
    if (draft.kind === "table_autosave") {
      tableAutosave = draft.tableAutosave.enabled
        ? {
            autoSampling:
              draft.tableAutosave.samplingMode === "auto_sinc_cutoff"
                ? autoContext.result
                : null,
            quantities: commaSeparatedValues(draft.tableAutosave.tableQuantities),
            samplePeriodS:
              draft.tableAutosave.samplingMode === "auto_sinc_cutoff"
                ? readySamplePeriod(autoContext.result)
                : positiveNumber(draft.tableAutosave.samplePeriodS),
            samplingMode: draft.tableAutosave.samplingMode,
            sourceDriveIds:
              draft.tableAutosave.samplingMode === "auto_sinc_cutoff"
                ? autoContext.sourceDriveIds
                : [],
            sourceStageId: draft.stageId,
          }
        : null;
      continue;
    }
    if (draft.kind === "autosave") {
      if (!draft.autosave.enabled) {
        if (draft.autosave.clearAll || !draft.autosave.quantity.trim()) {
          outputs.clear();
        } else {
          outputs.delete(draft.autosave.quantity.trim());
        }
        continue;
      }
      const quantity = draft.autosave.quantity.trim();
      outputs.set(quantity, {
        autoSampling:
          draft.autosave.samplingMode === "auto_sinc_cutoff"
            ? autoContext.result
            : null,
        everySeconds:
          draft.autosave.samplingMode === "auto_sinc_cutoff"
            ? readySamplePeriod(autoContext.result)
            : positiveNumber(draft.autosave.everySeconds),
        outputKind: draft.autosave.outputKind,
        quantity,
        samplingMode: draft.autosave.samplingMode,
        sourceDriveIds:
          draft.autosave.samplingMode === "auto_sinc_cutoff"
            ? autoContext.sourceDriveIds
            : [],
        sourceStageId: draft.stageId,
      });
      continue;
    }
    if (draft.kind === "fft_response") {
      fftResponse = draft.fftResponse.enabled
        ? {
            detrend: draft.fftResponse.detrend,
            responseComponent: draft.fftResponse.responseComponent,
            sourceStageId: draft.stageId,
            susceptibilityFloorFraction: finiteFraction(
              draft.fftResponse.susceptibilityFloorFraction,
            ),
            window: draft.fftResponse.window,
          }
        : null;
    }
  }

  return {
    fftResponse,
    outputs: [...outputs.values()],
    tableAutosave,
  };
}

export function validateStudyWorkflow(
  drafts: readonly StudyStageDraft[],
): StudyWorkflowValidationIssue[] {
  const issues: StudyWorkflowValidationIssue[] = [];
  for (const [index, draft] of drafts.entries()) {
    if (draft.kind !== "run") continue;
    const state = resolveStudyWorkflowStateBefore(drafts, index);
    if (state.fftResponse && !state.tableAutosave) {
      issues.push({
        index,
        message:
          "FFT response is ON, but no preceding Table autosave ON stage defines t_sampling.",
        severity: "error",
      });
      continue;
    }
    if (state.fftResponse && state.tableAutosave) {
      const quantities = new Set(
        state.tableAutosave.quantities.map((quantity) => quantity.toLowerCase()),
      );
      if (!quantities.has(state.fftResponse.responseComponent)) {
        issues.push({
          index,
          message: `FFT response component ${state.fftResponse.responseComponent} is missing from the active table quantities.`,
          severity: "error",
        });
      }
    }
    for (const output of state.outputs) {
      if (
        output.samplingMode === "auto_sinc_cutoff" &&
        output.autoSampling?.status === "unresolved"
      ) {
        issues.push({
          index,
          message: `Automatic sampling for output ${output.quantity} is unresolved: no active sinc drive with a finite positive cutoff applies to this Run.`,
          severity: "error",
        });
      }
    }
    if (!state.tableAutosave) continue;
    if (
      state.tableAutosave.samplingMode === "auto_sinc_cutoff" &&
      state.tableAutosave.autoSampling?.status === "unresolved"
    ) {
      issues.push({
        index,
        message:
          "Automatic sampling is unresolved: no active sinc drive with a finite positive cutoff applies to this Run.",
        severity: "error",
      });
      continue;
    }
    if (state.tableAutosave.samplePeriodS === null) continue;
    const nyquistHz = 1 / (2 * state.tableAutosave.samplePeriodS);
    for (const drive of activeSincDrivesBefore(drafts, index, draft.stageId)) {
      const cutoffHz = drive.fieldDrive.waveform.kind === "sinc_pulse"
        ? drive.fieldDrive.waveform.cutoff_hz
        : 0;
      if (Number.isFinite(nyquistHz) && nyquistHz < cutoffHz) {
        issues.push({
          index,
          message: `Active t_sampling violates Nyquist for antenna ${drive.fieldDrive.id}: ${cutoffHz} Hz cutoff exceeds ${nyquistHz} Hz Nyquist.`,
          severity: "error",
        });
      }
    }
  }
  return issues;
}

function activeSincDrivesBefore(
  drafts: readonly StudyStageDraft[],
  runIndex: number,
  runStageId: string,
): StudyStageDraft[] {
  return drafts.slice(0, runIndex).filter((candidate) => {
    if (
      candidate.kind !== "add_field_drive" ||
      !candidate.fieldDrive.enabled ||
      candidate.fieldDrive.waveform.kind !== "sinc_pulse"
    ) {
      return false;
    }
    const activation = candidate.fieldDrive.activation;
    return (
      activation.kind === "all_time_evolution" ||
      activation.stage_ids.includes(runStageId)
    );
  });
}

function automaticSamplingContext(
  drafts: readonly StudyStageDraft[],
  runIndex: number,
): {
  result: AutoSincSamplingResult;
  sourceDriveIds: readonly string[];
} {
  const run = drafts[runIndex];
  const drives = run?.kind === "run"
    ? activeSincDrivesBefore(drafts, runIndex, run.stageId)
    : [];
  return {
    result: resolveAutoSincSampling({
      cutoffHz: drives.map((drive) =>
        drive.fieldDrive.waveform.kind === "sinc_pulse"
          ? drive.fieldDrive.waveform.cutoff_hz
          : Number.NaN,
      ),
    }),
    sourceDriveIds: drives.map((drive) => drive.fieldDrive.id),
  };
}

function readySamplePeriod(result: AutoSincSamplingResult): number | null {
  return result.status === "ready" ? result.samplePeriodS : null;
}

function commaSeparatedValues(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function positiveNumber(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : Number.NaN;
}

function finiteFraction(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed < 1
    ? parsed
    : Number.NaN;
}
