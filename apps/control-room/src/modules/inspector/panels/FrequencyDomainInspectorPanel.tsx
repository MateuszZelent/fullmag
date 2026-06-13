"use client";

import { useRef, useState } from "react";

import {
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_CANCEL_REQUESTED_V1_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_FIELD_META_PATH,
  MESHING_PERIODIC_PAIRS_PATH,
} from "@/kernel/api/apiPaths";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import {
  useFrequencyDomainEigenModeFieldMetaResource,
  useFrequencyDomainEigenModeResource,
  useFrequencyDomainEigenBranchesResource,
  useFrequencyDomainEigenDispersionResource,
  useFrequencyDomainEigenSpectrumResource,
  useFrequencyDomainManifestResource,
  useFrequencyDomainResponseFieldMetaResource,
  useFrequencyDomainResponseCancelRequestedResource,
  useFrequencyDomainResponseFrequencyPointResource,
  useFrequencyDomainResponseProgressResource,
  useFrequencyDomainResponseSweepResource,
  useMeshPeriodicPairsResource,
} from "@/kernel/resources/studyRuntimeResources";
import {
  buildEigenDispersionChartModel,
  buildEigenBranchesModel,
  buildEigenSpectrumChartModel,
  buildFrequencyResponseChartModel,
  buildFmrPeakTableModel,
  responseFieldResourcesFromManifest,
  routeFrequencyDomainCalculationMode,
} from "@/shared/domain/analysis/frequencyDomainChartModels";

import type { InspectorPanelProps } from "../inspectorTypes";
import {
  FrequencyDomainDispersionChart,
  FrequencyDomainResponseChart,
  FrequencyDomainSpectrumChart,
} from "./FrequencyDomainCharts";
import {
  FrequencyDomainBranchTable,
  FrequencyDomainFmrPeakTable,
  FrequencyDomainModeTable,
  FrequencyDomainResponsePointTable,
} from "./FrequencyDomainTables";
import type {
  FrequencyDomainModeTableAction,
  FrequencyDomainResponsePointAction,
} from "./FrequencyDomainTables";
import { resolveFrequencyDomainNodeDetail } from "./frequencyDomainNodeDetails";
import { FieldRow } from "../primitives/FieldRow";
import { InspectorSection } from "../primitives/InspectorSection";

const DEFAULT_ANALYSIS_FIELD_VIEW = "phase_rotated_real";
const ANALYSIS_FIELD_VIEW_OPTIONS = [
  DEFAULT_ANALYSIS_FIELD_VIEW,
  "real",
  "imag",
  "abs",
  "phase",
] as const;

function formatBoolean(value: boolean | null | undefined): string {
  if (value === true) return "yes";
  if (value === false) return "no";
  return "not available";
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "resource load failed";
}

function familyLabel(kind: string | null): string {
  if (!kind) return "Frequency-domain";
  if (kind.startsWith("results.eigen")) return "Modal eigen / dispersion";
  if (kind.startsWith("results.frequency_response")) {
    return "Driven frequency response";
  }
  if (kind.startsWith("resources.analysis.eigen")) return "Eigen resource";
  if (kind.startsWith("resources.analysis.frequency_response")) {
    return "Frequency-response resource";
  }
  if (kind === "resources.mesh.periodic_pairs") {
    return "Periodic / Floquet mesh resource";
  }
  if (kind.startsWith("jobs.frequency_domain")) return "Frequency-domain job";
  if (kind.startsWith("diagnostics.frequency_domain")) {
    return "Frequency-domain diagnostics";
  }
  return "Frequency-domain";
}

function formatList(values: readonly string[] | null | undefined): string {
  return values && values.length > 0 ? values.join(", ") : "not reported";
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatNumber(value: unknown, unit = ""): string {
  const parsed = finiteNumber(value);
  if (parsed == null) return "not available";
  return `${parsed}${unit}`;
}

function formatFrequency(valueHz: unknown): string {
  const parsed = finiteNumber(valueHz);
  if (parsed == null) return "not available";
  const abs = Math.abs(parsed);
  if (abs >= 1e9) return `${parsed / 1e9} GHz`;
  if (abs >= 1e6) return `${parsed / 1e6} MHz`;
  return `${parsed} Hz`;
}

function arrayLength(value: unknown): string {
  return Array.isArray(value) ? String(value.length) : "not available";
}

function formatRecordField(
  value: unknown,
  key: string,
  fallback = "not available",
): string {
  const item = record(value)?.[key];
  if (typeof item === "string" && item.trim()) return item;
  if (typeof item === "boolean") return formatBoolean(item);
  const numeric = finiteNumber(item);
  return numeric == null ? fallback : String(numeric);
}

function numberArray(value: unknown): number[] {
  return Array.isArray(value)
    ? value
        .map((item) => finiteNumber(item))
        .filter((item): item is number => item != null)
    : [];
}

function susceptibilityPairCount(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return "not available";
  return String(value.length);
}

function maxAbsComplexPairs(value: unknown): number | null {
  if (!Array.isArray(value)) return null;
  let maxValue: number | null = null;
  for (const pair of value) {
    if (!Array.isArray(pair)) continue;
    const real = finiteNumber(pair[0]);
    const imag = finiteNumber(pair[1]);
    if (real == null || imag == null) continue;
    const magnitude = Math.hypot(real, imag);
    maxValue = maxValue == null ? magnitude : Math.max(maxValue, magnitude);
  }
  return maxValue;
}

function formatScalar(value: number | null | undefined, unit = ""): string {
  if (value == null || !Number.isFinite(value)) return "not available";
  const normalized = Math.abs(value) < 1e-12 ? 0 : value;
  return `${normalized}${unit}`;
}

function normalizeAnalysisFieldView(value: string | null | undefined): string {
  if (value === "amplitude" || value === "complex") return "abs";
  return value && ANALYSIS_FIELD_VIEW_OPTIONS.includes(
    value as (typeof ANALYSIS_FIELD_VIEW_OPTIONS)[number],
  )
    ? value
    : DEFAULT_ANALYSIS_FIELD_VIEW;
}

function analysisFieldViewLabel(value: string): string {
  if (value === "real") return "Real";
  if (value === "imag") return "Imag";
  if (value === "abs") return "Complex (abs)";
  if (value === "phase") return "Phase";
  return "Phase-rotated real";
}

function analysisFieldViewOptions(
  availableViews: readonly string[] | null | undefined,
  defaultView: string | null | undefined,
): string[] {
  const normalized = (availableViews ?? ANALYSIS_FIELD_VIEW_OPTIONS).map(
    normalizeAnalysisFieldView,
  );
  const options = Array.from(new Set(normalized));
  const normalizedDefault = normalizeAnalysisFieldView(defaultView);
  const orderedOptions = [
    normalizedDefault,
    ...options.filter((option) => option !== normalizedDefault),
  ];
  return orderedOptions.length > 0 ? orderedOptions : [DEFAULT_ANALYSIS_FIELD_VIEW];
}

function selectedField3DPlotStatus(
  meta: {
    component_basis?: string | null;
    component_count?: number | null;
    value_kind?: string | null;
  } | null | undefined,
): string {
  if (!meta) return "metadata pending; command allowed by field id";
  if (
    meta.component_basis === "local_tangent_frame" ||
    meta.value_kind === "complex_tangent_vector" ||
    (meta.component_count != null && meta.component_count !== 3)
  ) {
    return "requires tangent-to-XYZ reconstruction artifact";
  }
  return "ready for spatial XYZ overlay";
}

function canPlotSelectedFieldIn3D(
  meta: {
    component_basis?: string | null;
    component_count?: number | null;
    value_kind?: string | null;
  } | null | undefined,
): boolean {
  return selectedField3DPlotStatus(meta) !==
    "requires tangent-to-XYZ reconstruction artifact";
}

function floquetKVectorFromManifest(manifestPayload: unknown): number[] {
  const payload = record(manifestPayload);
  const spinWaveBc = record(payload?.spin_wave_bc ?? payload?.spinWaveBc);
  return numberArray(
    spinWaveBc?.floquet_k_vector_rad_per_m ??
      spinWaveBc?.k_vector_rad_per_m ??
      spinWaveBc?.k_vector,
  );
}

function firstPeriodicPair(pairs: readonly unknown[]): Record<string, unknown> | null {
  return pairs.map(record).find((pair): pair is Record<string, unknown> => !!pair) ?? null;
}

function pairTranslation(pair: Record<string, unknown> | null): number[] {
  return numberArray(
    pair?.expected_translation_m ??
      pair?.translation_m ??
      pair?.delta_r_m ??
      pair?.delta_r,
  );
}

function dotProduct(left: readonly number[], right: readonly number[]): number | null {
  if (left.length === 0 || right.length === 0) return null;
  const length = Math.min(left.length, right.length);
  let value = 0;
  for (let index = 0; index < length; index += 1) {
    value += left[index]! * right[index]!;
  }
  return value;
}

function invalidPeriodicPairCount(pairs: readonly unknown[]): number {
  return pairs.filter((entry) => {
    const pair = record(entry);
    if (!pair) return true;
    const status = String(pair.status ?? "").toLowerCase();
    const unpairedSource = finiteNumber(pair.unpaired_source_node_count) ?? 0;
    const unpairedDestination = finiteNumber(pair.unpaired_destination_node_count) ?? 0;
    return status !== "ready" || unpairedSource > 0 || unpairedDestination > 0;
  }).length;
}

function maxPeriodicPairResidual(pairs: readonly unknown[]): number | null {
  const residuals = pairs
    .map(record)
    .flatMap((pair) => [
      finiteNumber(pair?.max_residual_m),
      finiteNumber(pair?.rms_residual_m),
    ])
    .filter((value): value is number => value != null);
  return residuals.length > 0 ? Math.max(...residuals) : null;
}

function parseKPathSummary(csv: string | null | undefined): {
  endpointLabels: string;
  pathSRange: string;
  sampleCount: number;
} {
  const lines = (csv ?? "").split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) {
    return { endpointLabels: "not available", pathSRange: "not available", sampleCount: 0 };
  }
  const headers = lines[0]?.split(",").map((item) => item.trim()) ?? [];
  const rows = lines.slice(1).map((line) => {
    const columns = line.split(",").map((item) => item.trim());
    return Object.fromEntries(headers.map((header, index) => [header, columns[index]]));
  });
  const pathValues = rows
    .map((row) => finiteNumber(row.path_s_rad_per_m ?? row.path_s ?? row.pathS))
    .filter((value): value is number => value != null);
  const labels = rows
    .map((row) => row.endpoint_label ?? row.k_label ?? row.label)
    .filter((value): value is string => !!value);
  return {
    endpointLabels:
      labels.length > 0 ? `${labels[0]} -> ${labels[labels.length - 1]}` : "not available",
    pathSRange:
      pathValues.length > 0
        ? `${Math.min(...pathValues)}-${Math.max(...pathValues)} rad/m`
        : "not available",
    sampleCount: pathValues.length,
  };
}

function isFrequencyDomainKind(
  kind: string,
  ...matches: readonly string[]
): boolean {
  return matches.some((match) => kind === match || kind.startsWith(`${match}.`));
}

function isExactFrequencyDomainKind(
  kind: string,
  ...matches: readonly string[]
): boolean {
  return matches.includes(kind);
}

function modePointKey(point: {
  rawModeIndex: number;
  sampleIndex: number;
}): string {
  return `${point.sampleIndex}:${point.rawModeIndex}`;
}

function modePointLabel(point: {
  frequencyHz: number;
  rawModeIndex: number;
  sampleIndex: number;
}): string {
  return `sample ${point.sampleIndex}, mode ${point.rawModeIndex}, ${formatFrequency(point.frequencyHz)}`;
}

export function FrequencyDomainInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const [commandMessage, setCommandMessage] = useState<string | null>(null);
  const [selectedSpectrumModeKey, setSelectedSpectrumModeKey] =
    useState<string | null>(null);
  const analysisFieldViewSelectRef = useRef<HTMLSelectElement | null>(null);
  const analysisFieldPhaseInputRef = useRef<HTMLInputElement | null>(null);
  const analysisFieldAnimationRateInputRef = useRef<HTMLInputElement | null>(null);
  const eigenModeBrowserViewSelectRef = useRef<HTMLSelectElement | null>(null);
  const eigenModeBrowserPhaseInputRef = useRef<HTMLInputElement | null>(null);
  const eigenModeBrowserAnimationRateInputRef =
    useRef<HTMLInputElement | null>(null);
  const selectedEigenModeViewSelectRef = useRef<HTMLSelectElement | null>(null);
  const selectedEigenModePhaseInputRef = useRef<HTMLInputElement | null>(null);
  const selectedEigenModeAnimationRateInputRef =
    useRef<HTMLInputElement | null>(null);
  const frequencyDomainRef =
    selection.ref?.type === "frequency-domain" ? selection.ref : null;
  const manifest = useFrequencyDomainManifestResource();
  const spectrum = useFrequencyDomainEigenSpectrumResource({
    enabled:
      selection.kind?.includes("eigen") ||
      selection.kind?.includes("fmr") ||
      selection.kind?.includes("frequency_domain") ||
      false,
  });
  const branches = useFrequencyDomainEigenBranchesResource({
    enabled:
      selection.kind?.includes("branch") ||
      selection.kind?.includes("dispersion") ||
      false,
  });
  const dispersion = useFrequencyDomainEigenDispersionResource({
    enabled:
      selection.kind?.includes("dispersion") ||
      selection.kind?.includes("k_path") ||
      false,
  });
  const responseSweep = useFrequencyDomainResponseSweepResource({
    enabled:
      selection.kind?.includes("frequency_response") ||
      selection.kind?.includes("response") ||
      selection.kind?.includes("fmr") ||
      false,
  });
  const responseProgress = useFrequencyDomainResponseProgressResource({
    enabled:
      selection.kind?.includes("frequency_response") ||
      selection.kind?.includes("response") ||
      selection.kind?.includes("fmr") ||
      false,
  });
  const responseCancelRequested =
    useFrequencyDomainResponseCancelRequestedResource({
      enabled:
        selection.kind?.includes("frequency_response") ||
        selection.kind?.includes("response") ||
        selection.kind?.includes("fmr") ||
        false,
    });
  const periodicPairs = useMeshPeriodicPairsResource({
    enabled:
      selection.kind === "resources.mesh.periodic_pairs" ||
      selection.kind?.includes("periodic_pairs") ||
      selection.kind?.includes("periodic_floquet") ||
      false,
  });
  const eigenModeFieldMeta = useFrequencyDomainEigenModeFieldMetaResource(
    frequencyDomainRef?.sampleIndex,
    frequencyDomainRef?.modeIndex,
    {
      enabled: selection.kind?.includes("eigen") ?? false,
    },
  );
  const eigenMode = useFrequencyDomainEigenModeResource(
    frequencyDomainRef?.sampleIndex,
    frequencyDomainRef?.modeIndex,
    {
      enabled: selection.kind === "results.eigen.mode",
    },
  );
  const responseFieldMeta = useFrequencyDomainResponseFieldMetaResource(
    frequencyDomainRef?.frequencyIndex,
    {
      enabled: selection.kind?.includes("frequency_response") ?? false,
    },
  );
  const responseFrequencyPoint = useFrequencyDomainResponseFrequencyPointResource(
    frequencyDomainRef?.frequencyIndex,
    {
      enabled:
        (selection.kind?.includes("frequency_response") ||
          selection.kind?.includes("response")) ??
        false,
    },
  );
  const data = manifest.data;
  const manifestPayload = data?.result_manifest?.payload;
  const manifestPhysics = record(record(manifestPayload)?.physics);
  const spectrumModel = buildEigenSpectrumChartModel(spectrum.data);
  const branchesModel = buildEigenBranchesModel(branches.data);
  const dispersionModel = buildEigenDispersionChartModel(dispersion.data);
  const responseModel = buildFrequencyResponseChartModel(responseSweep.data);
  const responseFieldResources =
    responseFieldResourcesFromManifest(manifestPayload);
  const fmrPeakModel = buildFmrPeakTableModel({
    responseSweep: responseSweep.data,
    spectrum: spectrum.data,
  });
  const chartRoute = routeFrequencyDomainCalculationMode(manifestPayload);
  const selectedFieldMeta = responseFieldMeta.data ?? eigenModeFieldMeta.data;
  const selectedFieldId = selectedFieldMeta?.field_id ?? frequencyDomainRef?.fieldId ?? null;
  const selectedField3DStatus = selectedField3DPlotStatus(selectedFieldMeta);
  const selectedField3DReady =
    Boolean(selectedFieldId) && canPlotSelectedFieldIn3D(selectedFieldMeta);
  const selectedFieldStatus =
    responseFieldMeta.status !== "idle"
      ? responseFieldMeta.status
      : eigenModeFieldMeta.status;
  const resourceStatus =
    manifest.status === "ready" && data
      ? "ready"
      : manifest.status === "error"
        ? "failed"
        : manifest.status;
  const responseFrequencyPointPayload = record(responseFrequencyPoint.data?.payload);
  const eigenModePayload = record(eigenMode.data);
  const eigenModeComponentSummary = record(eigenModePayload?.component_summary);
  const selectedBranch = branchesModel.branches.find(
    (branch) => branch.branchId === frequencyDomainRef?.branchId,
  );
  const selectedObservablePoints = responseModel.points.filter(
    (point) => point.observableId === frequencyDomainRef?.observableId,
  );
  const selectedObservableFrequencies = selectedObservablePoints.map(
    (point) => point.frequencyHz,
  );
  const selectedObservableAmplitudes = selectedObservablePoints
    .map((point) => point.amplitude)
    .filter((value): value is number => value != null);
  const modalPeakCount = fmrPeakModel.peaks.filter(
    (peak) => peak.source === "modal",
  ).length;
  const drivenPeakCount = fmrPeakModel.peaks.filter(
    (peak) => peak.source === "driven_response",
  ).length;
  const firstFmrPeak = fmrPeakModel.peaks[0] ?? null;
  const periodicPairRows = periodicPairs.data?.pairs ?? [];
  const representativePeriodicPair = firstPeriodicPair(periodicPairRows);
  const floquetKVector = floquetKVectorFromManifest(manifestPayload);
  const floquetDeltaR = pairTranslation(representativePeriodicPair);
  const floquetPhaseAngle = dotProduct(floquetKVector, floquetDeltaR);
  const kPathSummary = parseKPathSummary(dispersion.data?.text);
  const selectedFieldViewOptions = analysisFieldViewOptions(
    selectedFieldMeta?.available_views,
    selectedFieldMeta?.default_view,
  );
  const selectedFieldViewOptionsKey = selectedFieldViewOptions.join("|");
  const defaultAnalysisFieldView = normalizeAnalysisFieldView(
    selectedFieldMeta?.default_view,
  );
  const spectrumModeRows = [...spectrumModel.points].sort(
    (left, right) =>
      left.sampleIndex - right.sampleIndex ||
      left.frequencyHz - right.frequencyHz ||
      left.rawModeIndex - right.rawModeIndex,
  );
  const selectedSpectrumMode =
    spectrumModeRows.find(
      (point) => modePointKey(point) === selectedSpectrumModeKey,
    ) ??
    spectrumModeRows.find(
      (point) =>
        point.sampleIndex === frequencyDomainRef?.sampleIndex &&
        point.rawModeIndex === frequencyDomainRef?.modeIndex,
    ) ??
    spectrumModeRows[0] ??
    null;
  const selectedEigenModePoint =
    spectrumModeRows.find(
      (point) =>
        point.sampleIndex === frequencyDomainRef?.sampleIndex &&
        point.rawModeIndex === frequencyDomainRef?.modeIndex,
    ) ?? selectedSpectrumMode;
  const selectedEigenModeFieldId =
    selectedFieldId ??
    selectedEigenModePoint?.modeFieldId ??
    frequencyDomainRef?.fieldId ??
    null;
  const eigenModePayloadResourceRef = formatRecordField(
    eigenModePayload,
    "mode_field_resource_key",
    "",
  );
  const selectedEigenModeResourceRef =
    frequencyDomainRef?.resourceRef ??
    (eigenModePayloadResourceRef || selectedEigenModePoint?.modeFieldResourceKey) ??
    null;
  const selectedEigenMode3DReady =
    Boolean(selectedEigenModeFieldId) && canPlotSelectedFieldIn3D(selectedFieldMeta);
  const nodeDetail = resolveFrequencyDomainNodeDetail(selection);
  const kind = selection.kind ?? "";
  const selectedFieldIsEigen = kind.includes("eigen");
  const selectedFieldPlotCommand = selectedFieldIsEigen
    ? "analysis.eigen.plot-mode-3d"
    : "analysis.frequency-response.plot-response-field-3d";
  const selectedFieldPhaseCommand = selectedFieldIsEigen
    ? "analysis.eigen.set-mode-3d-phase"
    : "analysis.frequency-domain.set-3d-phase";
  const selectedFieldAnimationCommand = selectedFieldIsEigen
    ? "analysis.eigen.set-mode-3d-animation"
    : "analysis.frequency-domain.set-3d-animation";
  const selectedFieldOverlaySource = selectedFieldIsEigen
    ? "eigen-mode"
    : "frequency-response";
  const showFamilyContract = isExactFrequencyDomainKind(
    kind,
    "results.frequency_domain.root",
    "results.frequency_domain.run",
    "resources.analysis.frequency_domain",
    "resources.analysis.frequency_domain.manifest",
    "diagnostics.frequency_domain.root",
    "diagnostics.frequency_domain.capabilities",
  );
  const showPhysicsContract = isFrequencyDomainKind(
    kind,
    "results.frequency_domain.run",
    "results.eigen.study",
    "results.eigen.provenance",
    "results.frequency_response.study",
    "results.frequency_response.provenance",
    "study.stage.eigenmodes.setup",
    "study.stage.eigenmodes.equilibrium",
    "study.stage.eigenmodes.operator",
    "study.stage.frequency_response.setup",
    "study.stage.frequency_response.equilibrium",
    "study.stage.frequency_response.operator",
    "diagnostics.frequency_domain.equilibrium",
    "diagnostics.frequency_domain.operator",
  );
  const showPeriodicSection = isFrequencyDomainKind(
    kind,
    "resources.mesh.periodic_pairs",
    "study.stage.eigenmodes.boundary",
    "study.stage.eigenmodes.periodic_pairs",
    "study.stage.eigenmodes.k_path",
    "study.stage.frequency_response.boundary",
    "study.stage.frequency_response.periodic_pairs",
    "study.stage.frequency_response.k_grid",
    "results.eigen.k_path",
    "results.eigen.dispersion",
    "results.frequency_domain.dispersion",
    "diagnostics.frequency_domain.periodic_floquet",
  );
  const showDrivenSolver = isExactFrequencyDomainKind(
    kind,
    "results.frequency_response.root",
    "results.frequency_response.study",
    "results.frequency_response.diagnostics",
    "results.frequency_response.provenance",
    "resources.analysis.frequency_response.diagnostics",
    "resources.analysis.frequency_response",
    "results.frequency_domain.fmr_response_sweep",
    "study.stage.frequency_response",
    "study.stage.frequency_response.setup",
    "study.stage.frequency_response.excitation",
    "study.stage.frequency_response.sweep",
    "study.stage.frequency_response.solver",
  );
  const showResponseFields = isFrequencyDomainKind(
    kind,
    "resources.analysis.frequency_response.field",
    "results.frequency_response.frequency_points",
    "results.frequency_response.frequency_point",
  );
  const showResponseCancellation = isFrequencyDomainKind(
    kind,
    "results.frequency_response.progress",
    "results.frequency_response.cancel_requested",
    "resources.analysis.frequency_response.progress",
    "resources.analysis.frequency_response.cancel_requested",
    "jobs.frequency_domain.response_progress",
  );
  const showModalSolver = isExactFrequencyDomainKind(
    kind,
    "results.eigen.root",
    "results.eigen.study",
    "results.eigen.diagnostics",
    "results.eigen.provenance",
    "resources.analysis.eigen.diagnostics",
    "results.frequency_domain.fmr_modal_spectrum",
    "study.stage.eigenmodes",
    "study.stage.eigenmodes.setup",
    "study.stage.eigenmodes.solver",
    "study.stage.eigenmodes.outputs",
    "study.stage.eigenmodes.diagnostics",
  );
  const showPlotReadiness = isExactFrequencyDomainKind(
    kind,
    "results.frequency_domain.root",
    "results.frequency_domain.run",
    "results.frequency_domain.calculation_modes",
    "results.frequency_domain.fmr",
    "results.frequency_domain.fmr_modal_spectrum",
    "results.frequency_domain.fmr_response_sweep",
    "results.frequency_domain.dispersion",
    "results.frequency_domain.response_map",
    "results.frequency_domain.comparison",
    "diagnostics.frequency_domain.visualization",
  );
  const showKPath = isFrequencyDomainKind(
    kind,
    "results.eigen.k_path",
    "results.eigen.dispersion",
    "results.eigen.branches",
    "results.eigen.branch",
    "results.frequency_domain.dispersion",
    "resources.analysis.eigen.dispersion",
    "resources.analysis.eigen.branches",
    "study.stage.eigenmodes.k_path",
  );
  const isEigenModeResultNode = isFrequencyDomainKind(kind, "results.eigen.mode");
  const hasConcreteFrequencyDomainFieldSelection =
    Boolean(selectedFieldId) ||
    frequencyDomainRef?.frequencyIndex != null ||
    (frequencyDomainRef?.sampleIndex != null &&
      frequencyDomainRef?.modeIndex != null);
  const hasConcreteEigenModeSelection =
    selectedFieldIsEigen &&
    (Boolean(frequencyDomainRef?.fieldId) ||
      (frequencyDomainRef?.sampleIndex != null &&
        frequencyDomainRef?.modeIndex != null));
  const showSelectedField =
    hasConcreteFrequencyDomainFieldSelection &&
    ((Boolean(selectedFieldId) && !isEigenModeResultNode) ||
      isFrequencyDomainKind(
        kind,
        "resources.analysis.eigen.mode_field",
        "results.frequency_response.frequency_point",
        "resources.analysis.frequency_response.field",
      ));
  const showSelectedEigenMode = isFrequencyDomainKind(
    kind,
    "results.eigen.mode",
    "resources.analysis.eigen.mode_metadata",
    "resources.analysis.eigen.mode_field",
  ) && hasConcreteEigenModeSelection;
  const showSelectedBranch = isFrequencyDomainKind(
    kind,
    "results.eigen.branch",
    "results.eigen.branches",
  );
  const showSelectedResponsePoint = isFrequencyDomainKind(
    kind,
    "results.frequency_response.frequency_point",
    "resources.analysis.frequency_response.frequency_point",
    "resources.analysis.frequency_response.field",
  );
  const showSelectedObservable = isFrequencyDomainKind(
    kind,
    "results.frequency_response.observable",
    "results.frequency_response.observables",
    "resources.analysis.frequency_response.observables",
  );
  const showFmrPeaks = isFrequencyDomainKind(
    kind,
    "results.frequency_domain.fmr",
    "results.frequency_domain.fmr_peaks",
  );
  const showModalSpectrum = isFrequencyDomainKind(
    kind,
    "results.eigen.root",
    "results.eigen.spectrum",
    "results.eigen.modes",
    "resources.analysis.eigen.spectrum",
    "results.frequency_domain.fmr",
    "results.frequency_domain.fmr_modal_spectrum",
    "results.frequency_domain.fmr_peaks",
  );
  const showEigenModeBrowser =
    spectrumModeRows.length > 0 &&
    isExactFrequencyDomainKind(
      kind,
      "results.eigen.root",
      "results.eigen.spectrum",
      "results.eigen.modes",
      "resources.analysis.eigen.spectrum",
      "resources.analysis.eigen.mode_metadata",
      "resources.analysis.eigen.mode_field",
      "results.frequency_domain.fmr",
      "results.frequency_domain.fmr_modal_spectrum",
      "results.frequency_domain.fmr_peaks",
      "study.stage.eigenmodes.setup",
      "study.stage.eigenmodes.solver",
      "study.stage.eigenmodes.outputs",
      "diagnostics.frequency_domain.visualization",
    );
  const showDispersionChart = isFrequencyDomainKind(
    kind,
    "results.eigen.dispersion",
    "results.eigen.k_path",
    "results.eigen.branches",
    "results.eigen.branch",
    "resources.analysis.eigen.dispersion",
    "resources.analysis.eigen.branches",
    "results.frequency_domain.dispersion",
  );
  const showDrivenResponseChart = isFrequencyDomainKind(
    kind,
    "results.frequency_domain.fmr",
    "results.frequency_response.sweep",
    "results.frequency_response.frequency_points",
    "results.frequency_response.frequency_point",
    "results.frequency_response.observables",
    "results.frequency_response.observable",
    "resources.analysis.frequency_response.sweep",
    "results.frequency_domain.fmr_response_sweep",
  );
  const plotModePoint = (
    point: (typeof spectrumModel.points)[number],
    action: FrequencyDomainModeTableAction = DEFAULT_ANALYSIS_FIELD_VIEW,
    options: {
      animationRateHz?: number | null;
      phaseRad?: number | null;
      view?: string | null;
    } = {},
  ): void => {
    setSelectedSpectrumModeKey(modePointKey(point));
    if (action === "inspect") return;
    if (!point.modeFieldId) return;
    const animate = action === "animate";
    const view = normalizeAnalysisFieldView(
      options.view ?? (animate ? DEFAULT_ANALYSIS_FIELD_VIEW : action),
    );
    void kernel.commands
      .execute(
        animate
          ? "analysis.eigen.set-mode-3d-animation"
          : "analysis.eigen.plot-mode-3d",
        createCommandContext("inspector", kernel, {
          sourceDetail: selection.kind ?? "frequency-domain",
        }),
        {
          animatePhase: animate ? true : undefined,
          animationRateHz: animate ? options.animationRateHz ?? 1 : undefined,
          fieldId: point.modeFieldId,
          label: `Mode ${point.rawModeIndex}`,
          phaseRad: options.phaseRad ?? 0,
          source: "eigen-mode",
          view,
        },
      )
      .then((result) => {
        setCommandMessage(result.message ?? result.status);
      });
  };
  const plotSelectedSpectrumMode = (
    action: FrequencyDomainModeTableAction,
  ): void => {
    if (!selectedSpectrumMode) return;
    plotModePoint(selectedSpectrumMode, action, {
      animationRateHz: finiteNumber(
        eigenModeBrowserAnimationRateInputRef.current?.value,
      ),
      phaseRad: finiteNumber(eigenModeBrowserPhaseInputRef.current?.value),
      view: eigenModeBrowserViewSelectRef.current?.value,
    });
  };
  const plotSelectedEigenModeField = (
    action: FrequencyDomainModeTableAction,
  ): void => {
    if (action === "inspect" || !selectedEigenModeFieldId) return;
    const animate = action === "animate";
    const selectedView = selectedEigenModeViewSelectRef.current?.value;
    const view = normalizeAnalysisFieldView(
      selectedView ?? (animate ? DEFAULT_ANALYSIS_FIELD_VIEW : action),
    );
    void kernel.commands
      .execute(
        animate
          ? "analysis.eigen.set-mode-3d-animation"
          : "analysis.eigen.plot-mode-3d",
        createCommandContext("inspector", kernel, {
          sourceDetail: selection.kind ?? "frequency-domain",
        }),
        {
          animatePhase: animate ? true : undefined,
          animationRateHz: animate
            ? finiteNumber(selectedEigenModeAnimationRateInputRef.current?.value) ?? 1
            : undefined,
          componentBasis: selectedFieldMeta?.component_basis ?? null,
          componentCount: selectedFieldMeta?.component_count ?? null,
          fieldId: selectedEigenModeFieldId,
          label:
            selection.label ??
            `Mode ${selectedEigenModePoint?.rawModeIndex ?? frequencyDomainRef?.modeIndex ?? ""}`,
          phaseRad:
            finiteNumber(selectedEigenModePhaseInputRef.current?.value) ??
            selectedFieldMeta?.default_phase_rad ??
            0,
          source: "eigen-mode",
          valueKind: selectedFieldMeta?.value_kind ?? null,
          view,
        },
      )
      .then((result) => {
        setCommandMessage(result.message ?? result.status);
      });
  };
  const plotResponsePoint = (
    point: (typeof responseModel.points)[number],
    action: FrequencyDomainResponsePointAction = DEFAULT_ANALYSIS_FIELD_VIEW,
  ): void => {
    if (!point.fieldId) return;
    const animate = action === "animate";
    void kernel.commands
      .execute(
        animate
          ? "analysis.frequency-domain.set-3d-animation"
          : "analysis.frequency-response.plot-response-field-3d",
        createCommandContext("inspector", kernel, {
          sourceDetail: selection.kind ?? "frequency-domain",
        }),
        {
          animatePhase: animate ? true : undefined,
          animationRateHz: animate ? 1 : undefined,
          fieldId: point.fieldId,
          label: `${point.observableId} ${formatFrequency(point.frequencyHz)}`,
          phaseRad: point.phaseRad ?? 0,
          source: "frequency-response",
          view: animate ? DEFAULT_ANALYSIS_FIELD_VIEW : action,
        },
      )
      .then((result) => {
        setCommandMessage(result.message ?? result.status);
      });
  };

  return (
    <div className="fm-inspector-panel">
      <InspectorSection
        title={familyLabel(selection.kind)}
        badge={resourceStatus}
      >
        <FieldRow label="Selection kind" value={selection.kind ?? "none"} />
        <FieldRow label="Node ID" value={selection.nodeId ?? "not selected"} />
        <FieldRow
          label="Selected resource"
          value={frequencyDomainRef?.resourceRef ?? "not selected"}
        />
        <FieldRow
          label="Selected artifact"
          value={frequencyDomainRef?.artifactPath ?? "not selected"}
        />
        <FieldRow label="Manifest resource" value={manifest.status} />
        <FieldRow label="Resource revision" value={manifest.revision ?? "n/a"} />
        {manifest.error ? (
          <FieldRow label="Load error" value={formatError(manifest.error)} />
        ) : null}
      </InspectorSection>

      <InspectorSection title={nodeDetail.title} badge="per-node">
        <FieldRow label="Node focus" value={nodeDetail.focus} />
        <FieldRow label="Node resource" value={nodeDetail.resource} />
        <FieldRow label="Node artifact" value={nodeDetail.artifact} />
        <FieldRow label="Visualization contract" value={nodeDetail.visualization} />
      </InspectorSection>

      {showFamilyContract ? (
      <InspectorSection title="Solver Family Contract" badge={data?.schema_version ?? "missing"}>
        <FieldRow
          label="Family namespace"
          value={data?.family_namespace ?? "frequencyDomain"}
        />
        <FieldRow
          label="Driven namespace"
          value={
            data?.existing_frequency_response_namespace_preserved
              ? "frequencyResponse preserved"
              : "not reported"
          }
        />
        <FieldRow label="Modal namespace" value={data?.eigen_namespace ?? "eigen"} />
        <FieldRow
          label="Floquet nonzero-k response"
          value={formatBoolean(data?.floquet_nonzero_k_response_supported)}
        />
        <FieldRow
          label="Floquet nonzero-k demag"
          value={formatBoolean(data?.floquet_nonzero_k_demag_supported)}
        />
      </InspectorSection>
      ) : null}

      {showPhysicsContract ? (
      <InspectorSection
        title="Physics Contract"
        badge={formatRecordField(manifestPhysics, "analysis_family")}
      >
        <FieldRow
          label="Analysis family"
          value={formatRecordField(manifestPhysics, "analysis_family")}
        />
        <FieldRow
          label="Temporal phase convention"
          value={formatRecordField(manifestPhysics, "phase_convention")}
        />
        <FieldRow
          label="Frequency units"
          value={formatRecordField(manifestPhysics, "frequency_units")}
        />
        <FieldRow
          label="Field units"
          value={formatRecordField(manifestPhysics, "field_units")}
        />
        <FieldRow
          label="Normalization"
          value={formatRecordField(manifestPhysics, "normalization")}
        />
      </InspectorSection>
      ) : null}

      {showPeriodicSection ? (
      <InspectorSection
        title="Periodic / Floquet Boundary Conditions"
        badge={periodicPairs.data?.schema_version ?? periodicPairs.status}
      >
        <FieldRow
          label="Periodic pairs resource"
          value={frequencyDomainRef?.resourceRef ?? MESHING_PERIODIC_PAIRS_PATH}
        />
        <FieldRow
          label="Periodic pairs status"
          value={periodicPairs.data ? "ready" : periodicPairs.status}
        />
        <FieldRow
          label="Pair count"
          value={
            periodicPairs.data ? String(periodicPairs.data.pairs.length) : "not loaded"
          }
        />
        <FieldRow
          label="Mesh revision"
          value={
            periodicPairs.data ? String(periodicPairs.data.revision) : "not loaded"
          }
        />
        <FieldRow
          label="Max residual"
          value={formatScalar(maxPeriodicPairResidual(periodicPairRows), " m")}
        />
        <FieldRow
          label="Invalid pairs"
          value={periodicPairs.data ? String(invalidPeriodicPairCount(periodicPairRows)) : "not loaded"}
        />
        {periodicPairs.data?.pairs.slice(0, 3).map((pair) => (
          <FieldRow
            key={pair.pair_id}
            label={`Pair ${pair.pair_id}`}
            value={`${pair.status}; markers ${pair.marker_a}/${pair.marker_b}; paired nodes ${pair.paired_node_count}`}
          />
        ))}
        <FieldRow
          label="Static periodic PBC"
          value={data?.capabilities.boundary.static_periodic.status ?? "unknown"}
        />
        <FieldRow
          label="Periodic diagnostics"
          value={
            data?.capabilities.boundary.periodic_pair_diagnostics.status ??
            "unknown"
          }
        />
        <FieldRow
          label="Floquet modal"
          value={data?.capabilities.boundary.floquet_modal.status ?? "unknown"}
        />
        <FieldRow
          label="Floquet response"
          value={data?.capabilities.boundary.floquet_response.status ?? "unknown"}
        />
        <FieldRow
          label="Dynamic demag-k"
          value={data?.capabilities.demag.floquet_dynamic_k.status ?? "unknown"}
        />
        <FieldRow
          label="Demag-k policy"
          value={
            data?.capabilities.demag.floquet_dynamic_k.reason ??
            "nonzero-k demag status not reported"
          }
        />
        <FieldRow
          label="Floquet phase preview"
          value={
            floquetPhaseAngle == null
              ? "not available"
              : "exp(-i k dot delta_r)"
          }
        />
        <FieldRow
          label="Phase angle"
          value={formatScalar(floquetPhaseAngle, " rad")}
        />
        <FieldRow
          label="Re(exp(-i k dot delta_r))"
          value={formatScalar(
            floquetPhaseAngle == null ? null : Math.cos(floquetPhaseAngle),
          )}
        />
        <FieldRow
          label="Im(exp(-i k dot delta_r))"
          value={formatScalar(
            floquetPhaseAngle == null ? null : -Math.sin(floquetPhaseAngle),
          )}
        />
        {periodicPairs.error ? (
          <FieldRow
            label="Periodic pairs error"
            value={formatError(periodicPairs.error)}
          />
        ) : null}
      </InspectorSection>
      ) : null}

      {showDrivenSolver ? (
      <InspectorSection title="Driven Response Solver" badge={data?.response.status ?? "unknown"}>
        <FieldRow
          label="Study kind"
          value={data?.response.study_kind ?? "frequency_response"}
        />
        <FieldRow
          label="Driven response"
          value={formatBoolean(data?.response.driven_response_available)}
        />
        <FieldRow
          label="Static-periodic response"
          value={formatBoolean(data?.response.static_periodic_response_available)}
        />
        <FieldRow
          label="CPU response status"
          value={data?.capabilities.response.magnetic_cpu.status ?? "unknown"}
        />
        <FieldRow
          label="Floquet response"
          value={formatBoolean(data?.response.floquet_response_available)}
        />
        <FieldRow label="GPU lane" value={formatBoolean(data?.response.gpu_available)} />
        <FieldRow label="Reason" value={data?.response.reason ?? "not reported"} />
      </InspectorSection>
      ) : null}

      {showResponseFields ? (
      <InspectorSection
        title="Response Field Resources"
        badge={
          responseFieldResources.length > 0
            ? `${responseFieldResources.length} response field(s)`
            : "not listed"
        }
      >
        <FieldRow
          label="Manifest entries"
          value={String(responseFieldResources.length)}
        />
        <FieldRow
          label="Meta resource pattern"
          value={ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_FIELD_META_PATH}
        />
        <FieldRow
          label="Selected field resource"
          value={frequencyDomainRef?.fieldId ?? "not selected"}
        />
        {responseFieldResources.slice(0, 6).map((entry) => (
          <FieldRow
            key={`${entry.frequencyIndex}:${entry.fieldResourceId}`}
            label={`Frequency ${entry.frequencyIndex}`}
            value={`${entry.fieldResourceId}; payload ${entry.payloadPath ?? "not available"}`}
          />
        ))}
      </InspectorSection>
      ) : null}

      {showResponseCancellation ? (
      <InspectorSection
        title="Response Cancellation"
        badge={responseCancelRequested.data?.status ?? responseCancelRequested.status}
      >
        <FieldRow
          label="Cancel state"
          value={responseCancelRequested.data?.status ?? "not requested"}
        />
        <FieldRow
          label="Completed frequencies"
          value={
            responseCancelRequested.data
              ? `${responseCancelRequested.data.completed_frequency_points}/${responseCancelRequested.data.total_frequency_points}`
              : "not available"
          }
        />
        <FieldRow
          label="Partial artifacts"
          value={formatBoolean(
            responseCancelRequested.data?.partial_artifacts_available,
          )}
        />
        <FieldRow
          label="Cancel manifest"
          value={
            responseCancelRequested.data?.latest_artifact_manifest_path ??
            "not available"
          }
        />
        <FieldRow
          label="Cancel resource"
          value={ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_CANCEL_REQUESTED_V1_PATH}
        />
        <FieldRow
          label="Cancel progress JSON"
          value={responseCancelRequested.data?.progress_json ?? "not available"}
        />
        {responseCancelRequested.error ? (
          <FieldRow
            label="Cancel resource error"
            value={formatError(responseCancelRequested.error)}
          />
        ) : null}
      </InspectorSection>
      ) : null}

      {showModalSolver ? (
      <InspectorSection title="Modal Eigen Solver" badge={data?.eigenmodes.status ?? "unknown"}>
        <FieldRow
          label="Study kind"
          value={data?.eigenmodes.study_kind ?? "eigenmodes"}
        />
        <FieldRow
          label="Modal solver"
          value={formatBoolean(data?.eigenmodes.modal_solver_available)}
        />
        <FieldRow
          label="Floquet modal"
          value={formatBoolean(data?.eigenmodes.floquet_modal_available)}
        />
        <FieldRow label="GPU lane" value={formatBoolean(data?.eigenmodes.gpu_available)} />
        <FieldRow label="Reason" value={data?.eigenmodes.reason ?? "not reported"} />
      </InspectorSection>
      ) : null}

      {showPlotReadiness ? (
      <InspectorSection title="Plot Readiness" badge="manifest-driven">
        <FieldRow
          label="FMR modal spectrum"
          value={
            data?.eigenmodes.modal_solver_available
              ? "can be exposed by modal artifacts"
              : "blocked"
          }
        />
        <FieldRow
          label="FMR response sweep"
          value={
            data?.response.driven_response_available
              ? "can be exposed by response artifacts"
              : "blocked"
          }
        />
        <FieldRow
          label="Dispersion"
          value={
            data?.floquet_nonzero_k_demag_supported
              ? "Floquet demag-k allowed"
              : "nonzero-k demag rejected"
          }
        />
        <FieldRow
          label="3D mode plotting"
          value="waiting for mode-field artifacts"
        />
      </InspectorSection>
      ) : null}

      {showKPath ? (
      <InspectorSection title="Bloch k-Path Parameters" badge={dispersion.status}>
        <FieldRow
          label="path_s range"
          value={kPathSummary.pathSRange}
        />
        <FieldRow
          label="Endpoint labels"
          value={kPathSummary.endpointLabels}
        />
        <FieldRow
          label="Sample count"
          value={String(kPathSummary.sampleCount)}
        />
        <FieldRow
          label="Dispersion x-axis"
          value="path_s_rad_per_m"
        />
      </InspectorSection>
      ) : null}

      {showEigenModeBrowser ? (
      <InspectorSection
        title="Eigen Mode Browser"
        badge={`${spectrumModeRows.length} mode(s)`}
      >
        <FieldRow
          label="Calculation mode"
          value={frequencyDomainRef?.calculationMode ?? chartRoute.mode}
        />
        <FieldRow
          label="Mode source"
          value={spectrum.data?.resource_key ?? "eigen spectrum resource"}
        />
        <FieldRow
          label="Selected mode"
          value={
            selectedSpectrumMode
              ? (
                  <select
                    aria-label="Select eigen mode for 3D visualization"
                    className="fm-inspector-select"
                    defaultValue={modePointKey(selectedSpectrumMode)}
                    key={`mode-browser:${modePointKey(selectedSpectrumMode)}:${spectrumModeRows.length}`}
                    onChange={(event) => {
                      setSelectedSpectrumModeKey(event.currentTarget.value);
                    }}
                  >
                    {spectrumModeRows.map((point) => (
                      <option key={modePointKey(point)} value={modePointKey(point)}>
                        {modePointLabel(point)}
                      </option>
                    ))}
                  </select>
                )
              : "not available"
          }
        />
        {selectedSpectrumMode ? (
          <>
            <FieldRow
              label="Selected mode frequency"
              value={formatFrequency(selectedSpectrumMode.frequencyHz)}
            />
            <FieldRow
              label="Selected sample"
              value={String(selectedSpectrumMode.sampleIndex)}
            />
            <FieldRow
              label="Selected raw mode"
              value={String(selectedSpectrumMode.rawModeIndex)}
            />
            <FieldRow
              label="Selected branch"
              value={selectedSpectrumMode.branchId ?? "not assigned"}
            />
            <FieldRow
              label="Selected damping"
              value={formatFrequency(selectedSpectrumMode.dampingRateHz)}
            />
            <FieldRow
              label="Selected residual"
              value={formatNumber(selectedSpectrumMode.residualNorm)}
            />
            <FieldRow
              label="Selected mode field"
              value={selectedSpectrumMode.modeFieldId ?? "not available"}
            />
            <FieldRow
              label="3D view"
              value={
                <select
                  aria-label="Eigen mode browser 3D view"
                  className="fm-inspector-select"
                  defaultValue={DEFAULT_ANALYSIS_FIELD_VIEW}
                  disabled={!selectedSpectrumMode.modeFieldId}
                  key={`mode-browser-view:${modePointKey(selectedSpectrumMode)}`}
                  ref={eigenModeBrowserViewSelectRef}
                >
                  {ANALYSIS_FIELD_VIEW_OPTIONS.map((view) => (
                    <option key={view} value={view}>
                      {analysisFieldViewLabel(view)}
                    </option>
                  ))}
                </select>
              }
            />
            <FieldRow
              label="Phase"
              value={
                <input
                  aria-label="Eigen mode browser phase"
                  className="fm-inspector-input"
                  defaultValue="0"
                  disabled={!selectedSpectrumMode.modeFieldId}
                  key={`mode-browser-phase:${modePointKey(selectedSpectrumMode)}`}
                  ref={eigenModeBrowserPhaseInputRef}
                  step="0.1"
                  type="number"
                />
              }
            />
            <FieldRow
              label="Animation rate"
              value={
                <input
                  aria-label="Eigen mode browser animation rate"
                  className="fm-inspector-input"
                  defaultValue="1"
                  disabled={!selectedSpectrumMode.modeFieldId}
                  key={`mode-browser-rate:${modePointKey(selectedSpectrumMode)}`}
                  max="10"
                  min="0.05"
                  ref={eigenModeBrowserAnimationRateInputRef}
                  step="0.05"
                  type="number"
                />
              }
            />
            <button
              className="fm-inspector-action-button"
              disabled={!selectedSpectrumMode.modeFieldId}
              type="button"
              onClick={() => plotSelectedSpectrumMode("phase_rotated_real")}
            >
              Plot selected rotated
            </button>
            <button
              className="fm-inspector-action-button"
              disabled={!selectedSpectrumMode.modeFieldId}
              type="button"
              onClick={() => plotSelectedSpectrumMode("real")}
            >
              Plot selected real
            </button>
            <button
              className="fm-inspector-action-button"
              disabled={!selectedSpectrumMode.modeFieldId}
              type="button"
              onClick={() => plotSelectedSpectrumMode("imag")}
            >
              Plot selected imag
            </button>
            <button
              className="fm-inspector-action-button"
              disabled={!selectedSpectrumMode.modeFieldId}
              type="button"
              onClick={() => plotSelectedSpectrumMode("abs")}
            >
              Plot selected abs
            </button>
            <button
              className="fm-inspector-action-button"
              disabled={!selectedSpectrumMode.modeFieldId}
              type="button"
              onClick={() => plotSelectedSpectrumMode("phase")}
            >
              Plot selected phase
            </button>
            <button
              className="fm-inspector-action-button"
              disabled={!selectedSpectrumMode.modeFieldId}
              type="button"
              onClick={() => plotSelectedSpectrumMode("animate")}
            >
              Animate selected mode
            </button>
          </>
        ) : null}
      </InspectorSection>
      ) : null}

      {showSelectedField ? (
      <InspectorSection title="Selected Field Metadata" badge={selectedFieldStatus}>
        <FieldRow
          label="Field ID"
          value={selectedFieldId ?? "not selected"}
        />
        <FieldRow
          label="Frequency index"
          value={
            frequencyDomainRef?.frequencyIndex != null
              ? String(frequencyDomainRef.frequencyIndex)
              : "not selected"
          }
        />
        <FieldRow
          label="Mode sample"
          value={
            frequencyDomainRef?.sampleIndex != null
              ? String(frequencyDomainRef.sampleIndex)
              : "not selected"
          }
        />
        <FieldRow
          label="Mode index"
          value={
            frequencyDomainRef?.modeIndex != null
              ? String(frequencyDomainRef.modeIndex)
              : "not selected"
          }
        />
        <FieldRow
          label="Value kind"
          value={selectedFieldMeta?.value_kind ?? "not available"}
        />
        <FieldRow
          label="Component basis"
          value={selectedFieldMeta?.component_basis ?? "not available"}
        />
        <FieldRow
          label="Component count"
          value={
            selectedFieldMeta?.component_count != null
              ? String(selectedFieldMeta.component_count)
              : "not available"
          }
        />
        <FieldRow
          label="Components"
          value={formatList(selectedFieldMeta?.components)}
        />
        <FieldRow
          label="Payload encoding"
          value={selectedFieldMeta?.payload_encoding ?? "not available"}
        />
        <FieldRow
          label="Binary layout"
          value={selectedFieldMeta?.binary_layout ?? "not available"}
        />
        <FieldRow
          label="Complex pairs"
          value={
            selectedFieldMeta?.complex_pair_count != null
              ? String(selectedFieldMeta.complex_pair_count)
              : "not available"
          }
        />
        <FieldRow
          label="Payload scalar values"
          value={
            selectedFieldMeta?.payload_value_count != null
              ? String(selectedFieldMeta.payload_value_count)
              : "not available"
          }
        />
        <FieldRow
          label="Raw tangent payload"
          value={selectedFieldMeta?.tangent_field_payload_path ?? "not available"}
        />
        <FieldRow
          label="Raw tangent basis"
          value={selectedFieldMeta?.tangent_component_basis ?? "not available"}
        />
        <FieldRow
          label="Raw tangent components"
          value={formatList(selectedFieldMeta?.tangent_components)}
        />
        <FieldRow
          label="Raw tangent encoding"
          value={selectedFieldMeta?.tangent_payload_encoding ?? "not available"}
        />
        <FieldRow
          label="Default 3D view"
          value={selectedFieldMeta?.default_view ?? "not available"}
        />
        <FieldRow
          label="Default phase"
          value={
            selectedFieldMeta?.default_phase_rad != null
              ? `${selectedFieldMeta.default_phase_rad} rad`
              : "not available"
          }
        />
        <FieldRow
          label="Available views"
          value={formatList(selectedFieldMeta?.available_views)}
        />
        <FieldRow
          label="3D plot status"
          value={selectedField3DStatus}
        />
        <FieldRow
          label="3D mode view"
          value={
            <select
              aria-label="Frequency-domain 3D field view"
              className="fm-inspector-select"
              defaultValue={defaultAnalysisFieldView}
              disabled={!selectedField3DReady}
              key={`${selectedFieldId ?? "none"}:${selectedFieldViewOptionsKey}:${defaultAnalysisFieldView}`}
              ref={analysisFieldViewSelectRef}
            >
              {selectedFieldViewOptions.map((view) => (
                <option key={view} value={view}>
                  {analysisFieldViewLabel(view)}
                </option>
              ))}
            </select>
          }
        />
        <FieldRow
          label="Data-plane resource"
          value={selectedFieldMeta?.resource_key ?? "not available"}
        />
        <FieldRow
          label="Set phase"
          value={
            <input
              aria-label="Frequency-domain 3D phase"
              className="fm-inspector-input"
              defaultValue={String(selectedFieldMeta?.default_phase_rad ?? 0)}
              disabled={!selectedField3DReady}
              key={`${selectedFieldId ?? "none"}:phase`}
              ref={analysisFieldPhaseInputRef}
              step="0.1"
              type="number"
            />
          }
        />
        <FieldRow
          label="Animation rate"
          value={
            <input
              aria-label="Frequency-domain mode animation rate"
              className="fm-inspector-input"
              defaultValue="1"
              disabled={!selectedField3DReady}
              key={`${selectedFieldId ?? "none"}:animation-rate`}
              max="10"
              min="0.05"
              ref={analysisFieldAnimationRateInputRef}
              step="0.05"
              type="number"
            />
          }
        />
        <button
          className="fm-inspector-action-button"
          disabled={!selectedField3DReady}
          type="button"
          onClick={() => {
            void kernel.commands
              .execute(
                selectedFieldPlotCommand,
                createCommandContext("inspector", kernel, {
                  sourceDetail: selection.kind ?? "frequency-domain",
                }),
                {
                  fieldId: selectedFieldId,
                  label: selection.label ?? selectedFieldId,
                  phaseRad:
                    finiteNumber(analysisFieldPhaseInputRef.current?.value) ??
                    selectedFieldMeta?.default_phase_rad ??
                    0,
                  componentBasis: selectedFieldMeta?.component_basis ?? null,
                  componentCount: selectedFieldMeta?.component_count ?? null,
                  source: selectedFieldOverlaySource,
                  valueKind: selectedFieldMeta?.value_kind ?? null,
                  view:
                    analysisFieldViewSelectRef.current?.value ??
                    defaultAnalysisFieldView,
                },
              )
              .then((result) => {
                setCommandMessage(result.message ?? result.status);
              });
          }}
        >
          Plot in 3D
        </button>
        {["phase_rotated_real", "real", "imag", "abs", "phase"].map((view) => (
          <button
            className="fm-inspector-action-button"
            disabled={!selectedField3DReady}
            key={view}
            type="button"
            onClick={() => {
              void kernel.commands
                .execute(
                  selectedFieldPlotCommand,
                  createCommandContext("inspector", kernel, {
                    sourceDetail: selection.kind ?? "frequency-domain",
                  }),
                  {
                    fieldId: selectedFieldId,
                    label: selection.label ?? selectedFieldId,
                    phaseRad:
                      finiteNumber(analysisFieldPhaseInputRef.current?.value) ??
                      selectedFieldMeta?.default_phase_rad ??
                      0,
                    componentBasis: selectedFieldMeta?.component_basis ?? null,
                    componentCount: selectedFieldMeta?.component_count ?? null,
                    source: selectedFieldOverlaySource,
                    valueKind: selectedFieldMeta?.value_kind ?? null,
                    view,
                  },
                )
                .then((result) => {
                  setCommandMessage(result.message ?? result.status);
                });
            }}
          >
            {view === "phase_rotated_real"
              ? "Plot rotated"
              : `Plot ${view}`}
          </button>
        ))}
        <button
          className="fm-inspector-action-button"
          disabled={!selectedField3DReady}
          type="button"
          onClick={() => {
            void kernel.commands
              .execute(
                selectedFieldPhaseCommand,
                createCommandContext("inspector", kernel, {
                  sourceDetail: selection.kind ?? "frequency-domain",
                }),
                {
                  phaseRad: finiteNumber(
                    analysisFieldPhaseInputRef.current?.value,
                  ) ?? 0,
                },
              )
              .then((result) => {
                setCommandMessage(result.message ?? result.status);
              });
          }}
        >
          Set phase
        </button>
        <button
          className="fm-inspector-action-button"
          disabled={!selectedField3DReady}
          type="button"
          onClick={() => {
            void kernel.commands
              .execute(
                selectedFieldAnimationCommand,
                createCommandContext("inspector", kernel, {
                  sourceDetail: selection.kind ?? "frequency-domain",
                }),
                {
                  animatePhase: true,
                  animationRateHz:
                    finiteNumber(
                      analysisFieldAnimationRateInputRef.current?.value,
                    ) ?? 1,
                  componentBasis: selectedFieldMeta?.component_basis ?? null,
                  componentCount: selectedFieldMeta?.component_count ?? null,
                  fieldId: selectedFieldId,
                  label: selection.label ?? selectedFieldId,
                  phaseRad:
                    finiteNumber(analysisFieldPhaseInputRef.current?.value) ??
                    selectedFieldMeta?.default_phase_rad ??
                    0,
                  source: selectedFieldOverlaySource,
                  valueKind: selectedFieldMeta?.value_kind ?? null,
                  view:
                    analysisFieldViewSelectRef.current?.value ??
                    defaultAnalysisFieldView,
                },
              )
              .then((result) => {
                setCommandMessage(result.message ?? result.status);
              });
          }}
        >
          Animate field phase
        </button>
        <button
          className="fm-inspector-action-button"
          disabled={!selectedField3DReady}
          type="button"
          onClick={() => {
            void kernel.commands
              .execute(
                selectedFieldAnimationCommand,
                createCommandContext("inspector", kernel, {
                  sourceDetail: selection.kind ?? "frequency-domain",
                }),
                {
                  animatePhase: false,
                  animationRateHz:
                    finiteNumber(
                      analysisFieldAnimationRateInputRef.current?.value,
                    ) ?? 1,
                  componentBasis: selectedFieldMeta?.component_basis ?? null,
                  componentCount: selectedFieldMeta?.component_count ?? null,
                  fieldId: selectedFieldId,
                  label: selection.label ?? selectedFieldId,
                  phaseRad:
                    finiteNumber(analysisFieldPhaseInputRef.current?.value) ??
                    selectedFieldMeta?.default_phase_rad ??
                    0,
                  source: selectedFieldOverlaySource,
                  valueKind: selectedFieldMeta?.value_kind ?? null,
                  view:
                    analysisFieldViewSelectRef.current?.value ??
                    defaultAnalysisFieldView,
                },
              )
              .then((result) => {
                setCommandMessage(result.message ?? result.status);
              });
          }}
        >
          Pause field phase
        </button>
        <button
          className="fm-inspector-action-button"
          type="button"
          onClick={() => {
            void kernel.commands
              .execute(
                "analysis.frequency-domain.clear-3d-overlay",
                createCommandContext("inspector", kernel, {
                  sourceDetail: "frequency-domain",
                }),
              )
              .then((result) => {
                setCommandMessage(result.message ?? result.status);
              });
          }}
        >
          Clear 3D overlay
        </button>
        {commandMessage ? (
          <FieldRow label="3D command" value={commandMessage} />
        ) : null}
      </InspectorSection>
      ) : null}

      {showSelectedEigenMode ? (
      <InspectorSection
        title="Selected Eigen Mode"
        badge={eigenMode.status}
      >
        <FieldRow
          label="Mode resource"
          value={
            frequencyDomainRef?.sampleIndex != null &&
            frequencyDomainRef?.modeIndex != null
              ? `eigen/modes/sample_${String(frequencyDomainRef.sampleIndex).padStart(4, "0")}/mode_${String(frequencyDomainRef.modeIndex).padStart(4, "0")}.json`
              : "not selected"
          }
        />
        <FieldRow
          label="Mode field resource"
          value={selectedEigenModeResourceRef ?? "not selected"}
        />
        <FieldRow
          label="Mode field ID"
          value={selectedEigenModeFieldId ?? "not selected"}
        />
        <FieldRow
          label="Mode field status"
          value={selectedEigenModeFieldId ? "3D command payload available" : "missing"}
        />
        <FieldRow
          label="Mode view"
          value={
            <select
              aria-label="Selected eigen mode 3D view"
              className="fm-inspector-select"
              defaultValue={defaultAnalysisFieldView}
              disabled={!selectedEigenMode3DReady}
              key={`${selectedEigenModeFieldId ?? "none"}:selected-mode-view`}
              ref={selectedEigenModeViewSelectRef}
            >
              {selectedFieldViewOptions.map((view) => (
                <option key={view} value={view}>
                  {analysisFieldViewLabel(view)}
                </option>
              ))}
            </select>
          }
        />
        <FieldRow
          label="Mode phase"
          value={
            <input
              aria-label="Selected eigen mode phase"
              className="fm-inspector-input"
              defaultValue={String(selectedFieldMeta?.default_phase_rad ?? 0)}
              disabled={!selectedEigenMode3DReady}
              key={`${selectedEigenModeFieldId ?? "none"}:selected-mode-phase`}
              ref={selectedEigenModePhaseInputRef}
              step="0.1"
              type="number"
            />
          }
        />
        <FieldRow
          label="Mode animation rate"
          value={
            <input
              aria-label="Selected eigen mode animation rate"
              className="fm-inspector-input"
              defaultValue="1"
              disabled={!selectedEigenMode3DReady}
              key={`${selectedEigenModeFieldId ?? "none"}:selected-mode-rate`}
              max="10"
              min="0.05"
              ref={selectedEigenModeAnimationRateInputRef}
              step="0.05"
              type="number"
            />
          }
        />
        <button
          className="fm-inspector-action-button"
          disabled={!selectedEigenMode3DReady}
          type="button"
          onClick={() => plotSelectedEigenModeField("phase_rotated_real")}
        >
          Plot mode rotated
        </button>
        <button
          className="fm-inspector-action-button"
          disabled={!selectedEigenMode3DReady}
          type="button"
          onClick={() => plotSelectedEigenModeField("real")}
        >
          Plot mode real
        </button>
        <button
          className="fm-inspector-action-button"
          disabled={!selectedEigenMode3DReady}
          type="button"
          onClick={() => plotSelectedEigenModeField("imag")}
        >
          Plot mode imag
        </button>
        <button
          className="fm-inspector-action-button"
          disabled={!selectedEigenMode3DReady}
          type="button"
          onClick={() => plotSelectedEigenModeField("abs")}
        >
          Plot mode abs
        </button>
        <button
          className="fm-inspector-action-button"
          disabled={!selectedEigenMode3DReady}
          type="button"
          onClick={() => plotSelectedEigenModeField("phase")}
        >
          Plot mode phase
        </button>
        <button
          className="fm-inspector-action-button"
          disabled={!selectedEigenMode3DReady}
          type="button"
          onClick={() => plotSelectedEigenModeField("animate")}
        >
          Animate mode phase
        </button>
        <FieldRow
          label="Sample index"
          value={
            frequencyDomainRef?.sampleIndex != null ||
            selectedEigenModePoint?.sampleIndex != null
              ? String(
                  frequencyDomainRef?.sampleIndex ??
                    selectedEigenModePoint?.sampleIndex,
                )
              : "not selected"
          }
        />
        <FieldRow
          label="Raw mode index"
          value={
            frequencyDomainRef?.modeIndex != null ||
            selectedEigenModePoint?.rawModeIndex != null
              ? String(
                  frequencyDomainRef?.modeIndex ??
                    selectedEigenModePoint?.rawModeIndex,
                )
              : "not selected"
          }
        />
        <FieldRow
          label="Spectrum branch"
          value={selectedEigenModePoint?.branchId ?? "not assigned"}
        />
        <FieldRow
          label="Mode frequency"
          value={formatFrequency(
            eigenModePayload?.frequency_real_hz ??
              selectedEigenModePoint?.frequencyHz,
          )}
        />
        <FieldRow
          label="Imaginary frequency"
          value={formatFrequency(
            eigenModePayload?.frequency_imag_hz ??
              selectedEigenModePoint?.imaginaryFrequencyHz,
          )}
        />
        <FieldRow
          label="Angular frequency"
          value={formatNumber(
            eigenModePayload?.angular_frequency_rad_per_s,
            " rad/s",
          )}
        />
        <FieldRow
          label="Residual"
          value={formatNumber(
            eigenModePayload?.residual_norm ??
              selectedEigenModePoint?.residualNorm,
          )}
        />
        <FieldRow
          label="Tangent leakage max"
          value={formatNumber(
            eigenModePayload?.tangent_leakage_max_abs ??
              selectedEigenModePoint?.tangentLeakageMax,
          )}
        />
        <FieldRow
          label="Dominant polarization"
          value={
            typeof eigenModePayload?.dominant_polarization === "string"
              ? eigenModePayload.dominant_polarization
              : "not available"
          }
        />
        <FieldRow
          label="Mode field samples"
          value={formatNumber(eigenModePayload?.mode_field_sample_count)}
        />
        <FieldRow
          label="Real samples"
          value={formatNumber(eigenModeComponentSummary?.real_sample_count)}
        />
        <FieldRow
          label="Imag samples"
          value={formatNumber(eigenModeComponentSummary?.imag_sample_count)}
        />
        {eigenMode.error ? (
          <FieldRow
            label="Mode resource error"
            value={formatError(eigenMode.error)}
          />
        ) : null}
      </InspectorSection>
      ) : null}

      {showSelectedBranch ? (
      <InspectorSection
        title="Selected Eigen Branch"
        badge={branches.status}
      >
        <FieldRow
          label="Branch ID"
          value={frequencyDomainRef?.branchId ?? "not selected"}
        />
        <FieldRow
          label="Branch label"
          value={selectedBranch?.label ?? "not available"}
        />
        <FieldRow
          label="Tracked points"
          value={
            selectedBranch ? String(selectedBranch.points.length) : "not available"
          }
        />
        <FieldRow
          label="Sample range"
          value={
            selectedBranch?.sampleMin != null && selectedBranch.sampleMax != null
              ? `${selectedBranch.sampleMin}-${selectedBranch.sampleMax}`
              : "not available"
          }
        />
        <FieldRow
          label="Frequency range"
          value={
            selectedBranch?.frequencyMinHz != null &&
            selectedBranch.frequencyMaxHz != null
              ? `${(selectedBranch.frequencyMinHz / 1e9).toFixed(6)}-${(selectedBranch.frequencyMaxHz / 1e9).toFixed(6)} GHz`
              : "not available"
          }
        />
        <FieldRow
          label="Min tracking confidence"
          value={formatNumber(selectedBranch?.trackingConfidenceMin)}
        />
        <FieldRow
          label="Min overlap"
          value={formatNumber(selectedBranch?.overlapPrevMin)}
        />
        <FieldRow
          label="Branch resource"
          value={frequencyDomainRef?.resourceRef ?? "not selected"}
        />
        <FrequencyDomainBranchTable branches={branchesModel.branches} />
        {branches.error ? (
          <FieldRow
            label="Branch resource error"
            value={formatError(branches.error)}
          />
        ) : null}
      </InspectorSection>
      ) : null}

      {showSelectedResponsePoint ? (
      <InspectorSection
        title="Selected Response Frequency Point"
        badge={responseFrequencyPoint.data?.status ?? responseFrequencyPoint.status}
      >
        <FieldRow
          label="Frequency point resource"
          value={responseFrequencyPoint.data?.resource_key ?? "not selected"}
        />
        <FieldRow
          label="Frequency point artifact"
          value={responseFrequencyPoint.data?.artifact_path ?? "not selected"}
        />
        <FieldRow
          label="Frequency"
          value={formatFrequency(responseFrequencyPointPayload?.frequency_hz)}
        />
        <FieldRow
          label="Angular frequency"
          value={formatNumber(
            responseFrequencyPointPayload?.angular_frequency_rad_per_s,
            " rad/s",
          )}
        />
        <FieldRow
          label="Absorbed power density"
          value={formatNumber(
            responseFrequencyPointPayload?.absorbed_power_density,
            " W/m^3",
          )}
        />
        <FieldRow
          label="Absorbed power provenance"
          value={formatRecordField(
            responseFrequencyPointPayload?.absorbed_power_density_provenance,
            "kind",
          )}
        />
        <FieldRow
          label="Susceptibility pairs"
          value={susceptibilityPairCount(
            responseFrequencyPointPayload?.susceptibility_tensor,
          )}
        />
        <FieldRow
          label="Max susceptibility magnitude"
          value={formatScalar(
            maxAbsComplexPairs(responseFrequencyPointPayload?.susceptibility_tensor),
          )}
        />
        <FieldRow
          label="Susceptibility provenance"
          value={formatRecordField(
            responseFrequencyPointPayload?.susceptibility_tensor_provenance,
            "kind",
          )}
        />
        <FieldRow
          label="Full susceptibility tensor"
          value={formatRecordField(
            responseFrequencyPointPayload?.susceptibility_tensor_provenance,
            "full_tensor",
          )}
        />
        <FieldRow
          label="Tangent leakage status"
          value={formatRecordField(
            responseFrequencyPointPayload?.tangent_leakage,
            "status",
          )}
        />
        <FieldRow
          label="Tangent leakage max"
          value={formatNumber(
            record(responseFrequencyPointPayload?.tangent_leakage)
              ?.max_abs_m0_dot_delta_m,
          )}
        />
        <FieldRow
          label="Residual"
          value={formatNumber(responseFrequencyPointPayload?.residual_l2_norm)}
        />
        <FieldRow
          label="Relative residual"
          value={formatNumber(
            responseFrequencyPointPayload?.relative_residual_l2_norm,
          )}
        />
        <FieldRow
          label="Complex entries"
          value={arrayLength(responseFrequencyPointPayload?.m_complex)}
        />
        <FieldRow
          label="Amplitude entries"
          value={arrayLength(
            responseFrequencyPointPayload?.component_response_amplitude ??
              responseFrequencyPointPayload?.response_amplitude,
          )}
        />
        <FieldRow
          label="Phase entries"
          value={arrayLength(
            responseFrequencyPointPayload?.component_response_phase ??
              responseFrequencyPointPayload?.response_phase,
          )}
        />
        {responseFrequencyPoint.error ? (
          <FieldRow
            label="Frequency point error"
            value={formatError(responseFrequencyPoint.error)}
          />
        ) : null}
      </InspectorSection>
      ) : null}

      {showSelectedObservable ? (
      <InspectorSection
        title="Selected Response Observable"
        badge={responseSweep.status}
      >
        <FieldRow
          label="Observable ID"
          value={frequencyDomainRef?.observableId ?? "not selected"}
        />
        <FieldRow
          label="Observable points"
          value={String(selectedObservablePoints.length)}
        />
        <FieldRow
          label="Frequency range"
          value={
            selectedObservableFrequencies.length > 0
              ? `${formatFrequency(Math.min(...selectedObservableFrequencies))}-${formatFrequency(Math.max(...selectedObservableFrequencies))}`
              : "not available"
          }
        />
        <FieldRow
          label="Mean amplitude"
          value={
            selectedObservableAmplitudes.length > 0
              ? formatNumber(
                  selectedObservableAmplitudes.reduce(
                    (sum, value) => sum + value,
                    0,
                  ) / selectedObservableAmplitudes.length,
                )
              : "not available"
          }
        />
        <FieldRow
          label="Sweep resource"
          value={frequencyDomainRef?.resourceRef ?? "not selected"}
        />
      </InspectorSection>
      ) : null}

      {showFmrPeaks ? (
      <InspectorSection title="FMR Peaks" badge={fmrPeakModel.peaks.length > 0 ? "ready" : "missing"}>
        <FieldRow label="Peak count" value={String(fmrPeakModel.peaks.length)} />
        <FieldRow label="Modal peaks" value={String(modalPeakCount)} />
        <FieldRow label="Driven peaks" value={String(drivenPeakCount)} />
        <FieldRow
          label="First peak source"
          value={firstFmrPeak?.source ?? "not available"}
        />
        <FieldRow
          label="First peak frequency"
          value={formatFrequency(firstFmrPeak?.frequencyHz)}
        />
        <FieldRow
          label="First peak field"
          value={firstFmrPeak?.fieldId ?? "not available"}
        />
        <FieldRow
          label="Peak diagnostics"
          value={
            fmrPeakModel.diagnostics.length > 0
              ? fmrPeakModel.diagnostics.join("; ")
              : "none"
          }
        />
        <FrequencyDomainFmrPeakTable peaks={fmrPeakModel.peaks} />
      </InspectorSection>
      ) : null}

      {showModalSpectrum ? (
      <InspectorSection title="Modal Spectrum" badge={spectrum.data?.status ?? spectrum.status}>
        <FieldRow
          label="Eigen spectrum"
          value={`${spectrumModel.points.length} points, ${spectrumModel.droppedPointCount} dropped`}
        />
        <FieldRow
          label="Mode controls"
          value={
            showEigenModeBrowser
              ? "available in Eigen Mode Browser"
              : "not available"
          }
        />
        <FrequencyDomainSpectrumChart model={spectrumModel} />
        <FrequencyDomainModeTable
          points={spectrumModel.points}
          onPlotMode={plotModePoint}
        />
        <FieldRow
          label="Spectrum resource"
          value={spectrum.data?.status ?? spectrum.status}
        />
      </InspectorSection>
      ) : null}

      {showDispersionChart ? (
      <InspectorSection title="Dispersion Chart" badge={dispersion.status}>
        <FieldRow
          label="Dispersion"
          value={`${dispersionModel.points.length} points, ${dispersionModel.series.length} series`}
        />
        <FrequencyDomainDispersionChart model={dispersionModel} />
        <FrequencyDomainBranchTable branches={branchesModel.branches} />
      </InspectorSection>
      ) : null}

      {showDrivenResponseChart ? (
      <InspectorSection title="Driven Response Chart" badge={responseSweep.data?.status ?? responseSweep.status}>
        <FieldRow
          label="Primary chart"
          value={`${chartRoute.primaryChart} (${chartRoute.mode})`}
        />
        <FieldRow
          label="Chart route"
          value={
            chartRoute.status === "available"
              ? "available"
              : chartRoute.unavailableReason ?? "unavailable"
          }
        />
        <FieldRow
          label="Response data source"
          value={responseModel.dataSourceVersion}
        />
        <FieldRow
          label="Response diagnostics"
          value={
            responseModel.diagnostics.length > 0
              ? responseModel.diagnostics.join("; ")
              : "none"
          }
        />
        <FieldRow
          label="Driven response"
          value={`${responseModel.points.length} points, ${responseModel.series.length} series`}
        />
        <FrequencyDomainResponseChart model={responseModel} />
        <FrequencyDomainResponsePointTable
          points={responseModel.points}
          onPlotResponsePoint={plotResponsePoint}
        />
        <FieldRow
          label="Response progress"
          value={`${responseProgress.data?.completed_frequency_points ?? 0}/${responseProgress.data?.total_frequency_points ?? 0} frequency points`}
        />
        <FieldRow
          label="Response progress status"
          value={responseProgress.data?.status ?? responseProgress.status}
        />
        <FieldRow
          label="Response progress state"
          value={responseProgress.data?.state ?? "not available"}
        />
        <FieldRow
          label="Response progress reason"
          value={responseProgress.data?.missing_reason ?? "none"}
        />
        <FieldRow
          label="Response sweep complete"
          value={formatBoolean(responseProgress.data?.complete)}
        />
        <FieldRow
          label="Partial response artifacts"
          value={formatBoolean(responseProgress.data?.partial_artifacts_available)}
        />
        <FieldRow
          label="Latest response manifest"
          value={
            responseProgress.data?.latest_artifact_manifest_path ??
            "not available"
          }
        />
        <FieldRow
          label="Response resource"
          value={responseSweep.data?.status ?? responseSweep.status}
        />
      </InspectorSection>
      ) : null}
    </div>
  );
}
