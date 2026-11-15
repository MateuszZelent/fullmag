"use client";

import type { FmrModalDrivenComparisonPoint, FmrPeakPoint } from "@/shared/domain/analysis/frequencyDomainChartModels";
import { formatFrequencyHz, formatFrequencyRangeHz } from "@/shared/domain/analysis/frequencyUnits";
import { ANALYSIS_FIELD_VIEW_OPTIONS, normalizeAnalysisFieldView } from "../FrequencyDomainModeDisplayControls";

export function missingValueSummary(
  values: readonly [label: string, value: number | null | undefined][],
): string {
  const missing = values.flatMap(([label, value]) =>
    value == null ? [label] : [],
  );
  return missing.length ? missing.join(", ") : "none";
}

export function frequencyDomainVisualizationReadiness({
  modeFieldCount,
  responseFieldCount,
}: {
  modeFieldCount: number;
  responseFieldCount: number;
}): string {
  if (modeFieldCount > 0 && responseFieldCount > 0) return "3D ready";
  if (modeFieldCount > 0) return "response fields missing";
  if (responseFieldCount > 0) return "mode fields missing";
  return "field artifacts missing";
}

export function frequencyResponseSweepStatusSummary({
  data,
  resourceKey,
  status,
}: {
  data: {
    complete?: boolean | null;
    completed_frequency_points?: number | null;
    current_frequency_hz?: number | null;
    demag_mode?: string | null;
    frequency_max_hz?: number | null;
    frequency_min_hz?: number | null;
    latest_artifact_manifest_path?: string | null;
    missing_reason?: string | null;
    partial_artifacts_available?: boolean | null;
    progress_json?: string | null;
    state?: string | null;
    status?: string | null;
    total_frequency_points?: number | null;
    written_frequency_point_artifacts?: number | null;
  } | null;
  resourceKey: string;
  status: string;
}) {
  const completed = data?.completed_frequency_points ?? null;
  const total = data?.total_frequency_points ?? null;
  const progress =
    completed == null || total == null
      ? "not available"
      : `${completed}/${total} frequency points`;
  const progressPercent = frequencyResponseProgressPercent(data);
  const runtimeState = data
    ? `${data.state ?? data.status ?? status}`
    : status;

  return {
    badge: runtimeState,
    complete: data?.complete === true ? "yes" : data?.complete === false ? "no" : "unknown",
    currentFrequency: formatFrequency(frequencyResponseCurrentFrequency(data)),
    frequencyRange: frequencyResponseProgressRangeSummary(data),
    latestManifest: data?.latest_artifact_manifest_path ?? "not available",
    partialArtifacts:
      data?.partial_artifacts_available === true
        ? "yes"
        : data?.partial_artifacts_available === false
          ? "no"
          : "unknown",
    progress,
    progressLabel: progress,
    progressPercent,
    reason: data?.missing_reason ?? "none",
    resourceKey,
    runtimeState,
    solverProgress: frequencyResponseProgressSolverSummary(data),
    status: data?.status ?? status,
    writtenArtifacts:
      data?.written_frequency_point_artifacts == null
        ? "not available"
        : String(data.written_frequency_point_artifacts),
  };
}

function frequencyResponseProgressRangeSummary(data: {
  frequency_max_hz?: number | null;
  frequency_min_hz?: number | null;
  progress_json?: string | null;
} | null): string {
  const topLevelRange = formatFrequencyRangeFromBounds(
    data?.frequency_min_hz,
    data?.frequency_max_hz,
  );
  if (topLevelRange !== "not available") return topLevelRange;
  const payload = parsedJsonRecord(data?.progress_json);
  return formatFrequencyRangeFromBounds(
    finiteOptionalNumber(payload?.frequency_min_hz),
    finiteOptionalNumber(payload?.frequency_max_hz),
  );
}

function frequencyResponseCurrentFrequency(data: {
  current_frequency_hz?: number | null;
  progress_json?: string | null;
} | null): number | null {
  const topLevelFrequency = finiteOptionalNumber(data?.current_frequency_hz);
  if (topLevelFrequency != null) return topLevelFrequency;
  const payload = parsedJsonRecord(data?.progress_json);
  return finiteOptionalNumber(payload?.current_frequency_hz);
}

function frequencyResponseProgressPercent(data: {
  complete?: boolean | null;
  completed_frequency_points?: number | null;
  progress_json?: string | null;
  total_frequency_points?: number | null;
} | null): number | null {
  if (data?.complete === true) return 100;
  const payload = parsedJsonRecord(data?.progress_json);
  const total =
    finiteOptionalNumber(data?.total_frequency_points) ??
    finiteOptionalNumber(payload?.total_frequency_points);
  if (total == null || total <= 0) return null;
  const completed = clampNumber(
    finiteOptionalNumber(data?.completed_frequency_points) ??
      finiteOptionalNumber(payload?.completed_frequency_points) ??
      0,
    0,
    total,
  );
  const nativeFrequencyIndex = finiteOptionalNumber(
    payload?.native_frequency_index,
  );
  const nativeSolveFraction = finiteOptionalNumber(
    payload?.native_current_frequency_solve_fraction,
  );
  const activeWork =
    nativeFrequencyIndex == null || nativeSolveFraction == null
      ? completed
      : Math.max(
          completed,
          clampNumber(nativeFrequencyIndex, 0, total) +
            clampNumber(nativeSolveFraction, 0, 1),
        );
  return clampNumber(
    Math.round((clampNumber(activeWork, 0, total) / total) * 100),
    0,
    100,
  );
}

function frequencyResponseProgressSolverSummary(data: {
  demag_mode?: string | null;
  progress_json?: string | null;
} | null): string {
  const payload = parsedJsonRecord(data?.progress_json);
  const parts = [
    data?.demag_mode ?? stringValue(payload?.demag_mode),
    formatGmresIteration(
      payload?.native_iteration_count,
      payload?.native_max_iterations_for_frequency,
    ),
    formatNativeSolveFraction(payload?.native_current_frequency_solve_fraction),
    formatProgressRelativeResidual(payload?.native_relative_residual_l2_norm),
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join("; ") : "not available";
}

function formatFrequencyRangeFromBounds(
  minHz: number | null | undefined,
  maxHz: number | null | undefined,
): string {
  if (
    minHz == null ||
    maxHz == null ||
    !Number.isFinite(minHz) ||
    !Number.isFinite(maxHz) ||
    minHz <= 0 ||
    maxHz <= 0 ||
    maxHz < minHz
  ) {
    return "not available";
  }
  if (minHz === maxHz) return formatFrequency(minHz);
  return `${formatFrequency(minHz)}-${formatFrequency(maxHz)}`;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function finiteOptionalNumber(value: unknown): number | null {
  return value == null ? null : finiteNumber(value);
}

function formatGmresIteration(
  value: unknown,
  maxValue?: unknown,
): string | null {
  const iteration = finiteOptionalNumber(value);
  if (iteration == null) return null;
  const maxIteration = finiteOptionalNumber(maxValue);
  return maxIteration == null
    ? `GMRES ${Math.round(iteration)}`
    : `GMRES ${Math.round(iteration)}/${Math.round(maxIteration)}`;
}

function formatNativeSolveFraction(value: unknown): string | null {
  const fraction = finiteOptionalNumber(value);
  if (fraction == null) return null;
  return `solve ${Math.round(clampNumber(fraction, 0, 1) * 100)}%`;
}

function formatProgressRelativeResidual(value: unknown): string | null {
  const residual = finiteOptionalNumber(value);
  return residual == null ? null : `relres ${residual.toExponential(3)}`;
}

export function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function isDrivenExcitationMissing(manifestPayload: unknown): boolean {
  if (!manifestPayload) return false;
  const payload = record(manifestPayload);
  if (!payload) return true;
  const excitation = record(payload.excitation);
  if (!excitation) return true;
  const field = excitation.field_au_per_m || excitation.excitation_field;
  if (!field || !Array.isArray(field)) return true;
  return field.every(v => v === 0);
}

export function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function nonnegativeFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

export function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parsedJsonRecord(value: unknown): Record<string, unknown> | null {
  const source = stringValue(value);
  if (!source) return null;
  try {
    return record(JSON.parse(source));
  } catch {
    return null;
  }
}

export function eigenDiagnosticTransportSummary(data: unknown): {
  productionCpuGate: string;
  solverModel: string;
  transport: string;
} {
  const artifact = record(data);
  const payload = record(artifact?.payload) ?? artifact;
  const solverModel =
    stringValue(payload?.solver_model) ??
    stringValue(payload?.solverModel) ??
    "not available";
  const transportPolicy =
    stringValue(payload?.basis_transport_policy) ??
    stringValue(payload?.basisTransportPolicy) ??
    "not available";
  const frameMismatch = finiteNumber(
    payload?.floquet_tangent_frame_max_mismatch ??
      payload?.floquetTangentFrameMaxMismatch,
  );
  const nonunitarity = finiteNumber(
    payload?.floquet_tangent_transport_max_nonunitarity ??
      payload?.floquetTangentTransportMaxNonunitarity,
  );
  const productionCpuRejectionReason =
    stringValue(payload?.production_cpu_rejection_reason) ??
    stringValue(payload?.productionCpuRejectionReason);
  const productionCpuRejectionScope =
    stringValue(payload?.production_cpu_rejection_scope) ??
    stringValue(payload?.productionCpuRejectionScope);
  const executionLane =
    stringValue(payload?.execution_lane) ??
    stringValue(payload?.executionLane) ??
    stringValue(payload?.resolved_execution_lane) ??
    stringValue(payload?.resolvedExecutionLane);
  const solverAdapter =
    stringValue(payload?.solver_adapter) ??
    stringValue(payload?.solverAdapter);
  const productionSolverAvailable =
    payload?.production_solver_available === true ||
    payload?.productionSolverAvailable === true;
  const sampleCount =
    finiteNumber(payload?.sample_count) ??
    finiteNumber(payload?.sampleCount);
  const acceptedProductionCpuGate =
    !productionCpuRejectionReason &&
    (executionLane === "production_cpu" ||
      productionSolverAvailable ||
      solverAdapter === "slepc_modal_eigen");

  return {
    productionCpuGate: productionCpuRejectionReason
      ? `${productionCpuRejectionReason}; ${
          productionCpuRejectionScope ?? "scope not reported"
        }`
      : acceptedProductionCpuGate
        ? `accepted production_cpu selected-spectrum modal k-path; adapter ${
            solverAdapter ?? "not reported"
          }; sample_count ${formatNullableNumber(sampleCount)}`
        : "not reported",
    solverModel,
    transport: `${transportPolicy}; frame mismatch ${formatNullableNumber(frameMismatch)}; nonunitarity ${formatNullableNumber(nonunitarity)}`,
  };
}

export function formatNullableNumber(value: number | null): string {
  return value == null ? "not available" : formatNumber(value);
}

export function responseExecutionLaneFromManifest(response: unknown): string {
  const responseRecord = record(response);
  const diagnostics = parsedJsonRecord(responseRecord?.diagnostics_json);
  const executionLane =
    stringValue(diagnostics?.execution_lane) ??
    stringValue(diagnostics?.resolved_execution_lane) ??
    stringValue(diagnostics?.requested_execution_lane);
  const responseStatus = stringValue(responseRecord?.status) ?? "missing";
  return `${executionLane ?? "not reported"}; response=${responseStatus}`;
}

export function requestedMagnetostaticBc(
  manifestPayload: Record<string, unknown> | null,
): string {
  const requestedExecution = record(manifestPayload?.requested_execution);
  return (
    stringValue(manifestPayload?.magnetostatic_bc) ??
    stringValue(requestedExecution?.magnetostatic_bc) ??
    "not available"
  );
}

function numericArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const parsed = finiteNumber(entry);
    return parsed == null ? [] : [parsed];
  });
}

export function formatSpinWaveBc(
  manifestPayload: Record<string, unknown> | null,
): string {
  const requestedExecution = record(manifestPayload?.requested_execution);
  const spinWaveBc =
    record(manifestPayload?.spin_wave_bc) ??
    record(requestedExecution?.spin_wave_bc);
  if (!spinWaveBc) return "not available";
  const kind = stringValue(spinWaveBc.kind) ?? "not available";
  const phase =
    stringValue(spinWaveBc.phase_convention) ??
    stringValue(spinWaveBc.phaseConvention) ??
    "not available";
  const kVector = numericArray(
    spinWaveBc.floquet_k_vector_rad_per_m ??
      spinWaveBc.k_vector_rad_per_m ??
      spinWaveBc.k_vector,
  );
  if (kVector.length === 0) {
    return `${kind}; phase ${phase}`;
  }
  return `${kind}; k [${kVector.map(formatNumber).join(", ")}] rad/m; phase ${phase}`;
}

export function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toPrecision(4);
}

export function formatNumberOrUnavailable(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value)
    ? "not available"
    : formatNumber(value);
}

export function formatQuantity(
  value: number | null | undefined,
  unit: string,
): string {
  if (value == null || !Number.isFinite(value)) return "not available";
  return `${formatNumber(value)} ${unit === "not published" ? "[unit not published]" : unit}`;
}

export function formatFmrModalPairLabel(pair: FmrModalDrivenComparisonPoint): string {
  const mode = pair.modalPeak.modeRef?.rawModeIndex ?? "?";
  return `mode ${mode} @ ${formatFrequency(pair.modalPeak.frequencyHz)}`;
}

export function formatFmrDrivenPairLabel(pair: FmrModalDrivenComparisonPoint): string {
  return `response @ ${formatFrequency(pair.drivenPeak.frequencyHz)}`;
}

export function formatFmrPairFieldHandoff(
  pair: FmrModalDrivenComparisonPoint,
): string {
  const modal = pair.modalPeak.fieldId ? "mode field ready" : "mode field missing";
  const driven = pair.drivenPeak.fieldId
    ? "driven field ready"
    : "driven field missing";
  return `${modal}; ${driven}`;
}

export function formatFmrPairAmplitudeRatio(
  pair: FmrModalDrivenComparisonPoint,
): string {
  const modalAmplitude = pair.modalPeak.amplitude;
  const drivenAmplitude = pair.drivenPeak.amplitude;
  if (
    modalAmplitude == null ||
    drivenAmplitude == null ||
    modalAmplitude === 0 ||
    !Number.isFinite(modalAmplitude) ||
    !Number.isFinite(drivenAmplitude)
  ) {
    return "not available";
  }
  return `${formatCompactNumberOrUnavailable(drivenAmplitude / modalAmplitude)} driven/modal`;
}

export function formatFmrPeakSourceLabel(peak: FmrPeakPoint): string {
  return peak.source === "modal" ? "Modal eigenmode" : "Driven response";
}

export function formatFmrPeakTarget(peak: FmrPeakPoint): string {
  if (peak.modeRef) {
    return `sample ${peak.modeRef.sampleIndex}, mode ${peak.modeRef.rawModeIndex}`;
  }
  if (peak.frequencyPointIndex != null) {
    return `frequency point ${peak.frequencyPointIndex}`;
  }
  return "not available";
}

export function formatFmrPeakQualityFactor(peak: FmrPeakPoint): string {
  if (
    peak.linewidthHz == null ||
    peak.linewidthHz <= 0 ||
    !Number.isFinite(peak.linewidthHz)
  ) {
    return "not available";
  }
  return formatCompactNumberOrUnavailable(peak.frequencyHz / peak.linewidthHz);
}

export function formatPowerDensity(
  value: number | null | undefined,
  unit = "not published",
): string {
  return value == null || !Number.isFinite(value)
    ? "not available"
    : `${formatCompactNumberOrUnavailable(value)} ${unit === "not published" ? "[unit not published]" : unit}`;
}

export function formatCompactNumberOrUnavailable(
  value: number | null | undefined,
): string {
  if (value == null || !Number.isFinite(value)) return "not available";
  return `${Number(value.toPrecision(6))}`;
}

export function meanFinite(values: readonly number[]): number | null {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function maxFinite(values: readonly number[]): number | null {
  if (!values.length) return null;
  return Math.max(...values);
}

export function formatFrequencyRange(valuesHz: readonly number[]): string {
  return formatFrequencyRangeHz(valuesHz);
}

export function formatNumberRange(values: readonly number[], unit = ""): string {
  if (!values.length) return "not available";
  return `${formatNumber(Math.min(...values))}-${formatNumber(Math.max(...values))}${unit}`;
}

export function formatFrequency(valueHz: number | null | undefined): string {
  return formatFrequencyHz(valueHz);
}

export function normalizedAnalysisFieldViewOptions(
  availableViews: readonly string[] | null | undefined,
  defaultView: string | null | undefined,
): readonly string[] {
  const defaultValue = normalizeAnalysisFieldView(defaultView);
  const normalized = new Set<string>();
  for (const view of availableViews?.length
    ? availableViews
    : ANALYSIS_FIELD_VIEW_OPTIONS) {
    const normalizedView = normalizeAnalysisFieldView(view);
    if (normalizedView !== defaultValue) normalized.add(normalizedView);
  }
  return [defaultValue, ...normalized];
}
