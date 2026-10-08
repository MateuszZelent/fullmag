import type { AnalysisFieldOverlayState } from "@/kernel/visualization/AnalysisFieldOverlayController";

export interface EigenModeIdentityViewModel {
  branchId: string | null;
  fieldId: string | null;
  label: string;
  modeId: string | null;
  modeIndex: number | null;
  resourceRef: string | null;
  sampleId: string | null;
  sampleIndex: number | null;
}

export interface EigenModeOverlayIdentity {
  analysisRunId: string | null;
  analysisStageId: string | null;
  artifactRevision: string | number | null;
  fieldId: string | null;
  frequencyHz: number | null;
  kPathCoordinateRadPerM: number | null;
  modeId: string | null;
  modeIndex: number | null;
  nodeId: string | null;
  sampleId: string | null;
  sampleIndex: number | null;
  wavevectorKf: readonly [number, number, number] | null;
}

export function buildEigenModeIdentityViewModel(input: {
  branchId?: string | null;
  fieldId?: string | null;
  modeId?: string | null;
  modeIndex?: number | null;
  resourceRef?: string | null;
  sampleId?: string | null;
  sampleIndex?: number | null;
}): EigenModeIdentityViewModel {
  const sampleIndex = input.sampleIndex ?? null;
  const modeIndex = input.modeIndex ?? null;
  return {
    branchId: input.branchId ?? null,
    fieldId: input.fieldId ?? null,
    modeId: input.modeId ?? null,
    label:
      sampleIndex == null || modeIndex == null
        ? "not selected"
        : `sample ${sampleIndex}, mode ${modeIndex}`,
    modeIndex,
    resourceRef: input.resourceRef ?? null,
    sampleId: input.sampleId ?? null,
    sampleIndex,
  };
}

export function hasCompleteEigenModeOverlayIdentity(
  target: EigenModeOverlayIdentity,
): boolean {
  return Boolean(
    hasIdentityValue(target.analysisRunId) &&
      hasIdentityValue(target.analysisStageId) &&
      target.artifactRevision !== null &&
      String(target.artifactRevision).trim().length > 0 &&
      hasIdentityValue(target.fieldId) &&
      hasIdentityValue(target.modeId) &&
      hasIdentityValue(target.nodeId) &&
      hasIdentityValue(target.sampleId) &&
      target.modeIndex !== null &&
      Number.isInteger(target.modeIndex) &&
      target.modeIndex >= 0 &&
      target.sampleIndex !== null &&
      Number.isInteger(target.sampleIndex) &&
      target.sampleIndex >= 0,
  );
}

export function isEigenModeInspectorSelection(
  kind: string | null | undefined,
  target: EigenModeOverlayIdentity,
): boolean {
  const isModeSelection =
    kind === "results.eigen.mode" ||
    kind === "results.dispersion.modal.mode_at_k" ||
    kind === "results.resonance.modal.mode";
  return isModeSelection && hasCompleteEigenModeOverlayIdentity(target);
}

export function isCurrentEigenModeOverlay(
  overlay: AnalysisFieldOverlayState | null,
  target: EigenModeOverlayIdentity,
): overlay is AnalysisFieldOverlayState {
  const intent = overlay?.modeIntent;
  if (
    !overlay ||
    overlay.source !== "eigen-mode" ||
    !intent ||
    !hasCompleteEigenModeOverlayIdentity(target)
  ) {
    return false;
  }
  if (
    overlay.fieldId !== target.fieldId ||
    intent.analysisRunId !== target.analysisRunId ||
    intent.analysisStageId !== target.analysisStageId ||
    intent.artifactRevision !== String(target.artifactRevision) ||
    intent.fieldId !== target.fieldId ||
    intent.modeId !== target.modeId ||
    intent.modeIndex !== target.modeIndex ||
    intent.nodeId !== target.nodeId ||
    intent.sampleId !== target.sampleId ||
    intent.sampleIndex !== target.sampleIndex ||
    overlay.modeIndex !== target.modeIndex ||
    overlay.sampleIndex !== target.sampleIndex
  ) {
    return false;
  }
  if (
    target.frequencyHz !== null &&
    overlay.frequencyHz !== target.frequencyHz
  ) {
    return false;
  }
  if (
    target.kPathCoordinateRadPerM !== null &&
    overlay.kPathCoordinateRadPerM !== target.kPathCoordinateRadPerM
  ) {
    return false;
  }
  return (
    target.wavevectorKf === null ||
    sameVector3(overlay.wavevectorKf, target.wavevectorKf)
  );
}

export function phaseRadForEigenModeViewChange(
  overlay: AnalysisFieldOverlayState | null,
  target: EigenModeOverlayIdentity,
): number {
  if (!isCurrentEigenModeOverlay(overlay, target)) return 0;
  const phaseRad = overlay.visualizationPhaseRad ?? overlay.query.phase_rad ?? 0;
  return Number.isFinite(phaseRad) ? phaseRad : 0;
}

export function formatSignedWavevectorKf(
  wavevectorKf: readonly number[] | null | undefined,
): string {
  if (!isFiniteVector3(wavevectorKf)) return "not available";
  const signed = wavevectorKf.map((component) => {
    if (component === 0) return "0";
    const magnitude = Math.abs(component);
    const formattedMagnitude =
      magnitude >= 10_000 || magnitude < 0.001
        ? magnitude.toExponential(3)
        : formatNumber(magnitude);
    return `${component > 0 ? "+" : "−"}${formattedMagnitude}`;
  });
  return `[${signed.join(", ")}] rad/m`;
}

function hasIdentityValue(value: string | null): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteVector3(
  value: readonly number[] | null | undefined,
): value is readonly [number, number, number] {
  return Boolean(
    value &&
      value.length === 3 &&
      value.every((component) => Number.isFinite(component)),
  );
}

function sameVector3(
  left: readonly number[] | null | undefined,
  right: readonly [number, number, number],
): boolean {
  return Boolean(
    isFiniteVector3(left) &&
      left[0] === right[0] &&
      left[1] === right[1] &&
      left[2] === right[2],
  );
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toPrecision(4);
}
