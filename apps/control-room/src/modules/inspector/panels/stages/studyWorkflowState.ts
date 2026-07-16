import type { StudyStageDraft } from "../StudyStageAuthoringModel";

export interface EffectiveStudyTableAutosave {
  quantities: readonly string[];
  samplePeriodS: number;
  sourceStageId: string;
}

export interface EffectiveStudyAutosaveOutput {
  everySeconds: number;
  outputKind: "field" | "scalar";
  quantity: string;
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

  for (let index = 0; index < limit; index += 1) {
    const draft = drafts[index];
    if (draft.kind === "table_autosave") {
      tableAutosave = draft.tableAutosave.enabled
        ? {
            quantities: commaSeparatedValues(draft.tableAutosave.tableQuantities),
            samplePeriodS: positiveNumber(draft.tableAutosave.samplePeriodS),
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
        everySeconds: positiveNumber(draft.autosave.everySeconds),
        outputKind: draft.autosave.outputKind,
        quantity,
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
    if (!state.tableAutosave) continue;
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
