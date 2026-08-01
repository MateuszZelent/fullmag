"use client";

import { useEffect, useMemo, useReducer, useRef } from "react";
import {
  Activity,
  CheckCircle2,
  Info,
  Play,
  RotateCw,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import {
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_BRANCHES_V2_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_CANCEL_REQUESTED_V1_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_FIELD_META_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
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
  buildEigenBranchSelectionRef,
  buildEigenDispersionChartModel,
  buildEigenDispersionPointSelectionRef,
  buildEigenBranchesModel,
  buildEigenModeSelectionRef,
  buildEigenSpectrumChartModel,
  buildFrequencyResponseChartModel,
  buildFrequencyResponsePointSelectionRef,
  buildFmrModalDrivenComparisonModel,
  buildFmrPeakTableModel,
  frequencyDomainManifestPayload,
  responseFieldResourcesFromManifest,
  routeFrequencyDomainCalculationMode,
} from "@/shared/domain/analysis/frequencyDomainChartModels";
import {
  formatFrequencyRangeBoundsHz,
} from "@/shared/domain/analysis/frequencyUnits";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";

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
import {
  buildFrequencyDomainCalculationModeRows,
  frequencyDomainResourceGroupLabel,
  periodicStatusView,
} from "./frequencyDomainInspectorModel";
import { FrequencyDomainModeDataPreviewDialog } from "./FrequencyDomainModeDataPreviewDialog";
import { resolveFrequencyDomainNodeDetail } from "./frequencyDomainNodeDetails";
import { FrequencyDomainEigenSection } from "./FrequencyDomainEigenSection";
import { FrequencyDomainResponseSection } from "./FrequencyDomainResponseSection";
import {
  formatBoolean,
  formatError,
  familyLabel,
  formatList,
  record,
  finiteNumber,
  formatNumber,
  formatFrequency,
  arrayLength,
  formatRecordField,
  susceptibilityPairCount,
  maxAbsComplexPairs,
  formatScalar,
  analysisFieldViewOptions,
  selectedField3DPlotStatus,
  canPlotSelectedFieldIn3D,
  floquetKVectorFromManifest,
  firstPeriodicPair,
  pairTranslation,
  dotProduct,
  invalidPeriodicPairCount,
  maxPeriodicPairResidual,
  parseKPathSummary,
  isFrequencyDomainKind,
  isExactFrequencyDomainKind,
  modePointKey,
  modePointLabel,
  fmrPeakKey,
  fmrPeakLabel,
} from "./frequency-domain/FrequencyDomainHelpers";
import { FieldRow } from "../primitives/FieldRow";
import { InspectorGroup } from "../primitives/InspectorGroup";
import {
  ANALYSIS_FIELD_VIEW_OPTIONS,
  analysisFieldViewLabel,
  DEFAULT_ANALYSIS_FIELD_VIEW,
  FrequencyDomainModeDisplayControls,
  normalizeAnalysisFieldView,
  useFrequencyDomainModeDisplaySettings,
} from "./FrequencyDomainModeDisplayControls";

const EIGEN_MODE_BROWSER_ACTIONS: readonly {
  action: FrequencyDomainModeTableAction;
  icon: LucideIcon;
  label: string;
  title: string;
  variant: "primary" | "secondary";
}[] = [
  {
    action: "phase_rotated_real",
    icon: RotateCw,
    label: "Rotated",
    title: "Plot selected eigen mode with phase-rotated real display",
    variant: "primary",
  },
  {
    action: "real",
    icon: Activity,
    label: "Real",
    title: "Plot selected eigen mode real component",
    variant: "secondary",
  },
  {
    action: "imag",
    icon: Activity,
    label: "Imag",
    title: "Plot selected eigen mode imaginary component",
    variant: "secondary",
  },
  {
    action: "abs",
    icon: Activity,
    label: "Abs",
    title: "Plot selected eigen mode complex magnitude",
    variant: "secondary",
  },
  {
    action: "phase",
    icon: RotateCw,
    label: "Phase",
    title: "Plot selected eigen mode phase",
    variant: "secondary",
  },
  {
    action: "animate",
    icon: Play,
    label: "Animate",
    title: "Animate selected eigen mode phase in 3D",
    variant: "secondary",
  },
];

// Helper functions extracted to ./frequency-domain/FrequencyDomainHelpers.ts

export type FrequencyDomainInspectorState = {
  calculationModeValidationMessage: string | null;
  commandMessage: string | null;
  draftCalculationMode: string | null;
  selectedEigenBranchId: string | null;
  selectedModeDataPreviewOpen: boolean;
  selectedModeDataPreviewPhaseRad: number | null;
  selectedModeDataPreviewView: string | null;
  selectedFmrPeakKey: string | null;
  selectedSpectrumModeKey: string | null;
};

const initialFrequencyDomainInspectorState: FrequencyDomainInspectorState = {
  calculationModeValidationMessage: null,
  commandMessage: null,
  draftCalculationMode: null,
  selectedEigenBranchId: null,
  selectedModeDataPreviewOpen: false,
  selectedModeDataPreviewPhaseRad: null,
  selectedModeDataPreviewView: null,
  selectedFmrPeakKey: null,
  selectedSpectrumModeKey: null,
};

function frequencyDomainInspectorReducer(
  state: FrequencyDomainInspectorState,
  patch: Partial<FrequencyDomainInspectorState>,
): FrequencyDomainInspectorState {
  return { ...state, ...patch };
}

export function FrequencyDomainInspectorPanel(props: InspectorPanelProps) {
  return useFrequencyDomainInspectorPanelView(props);
}

function useFrequencyDomainInspectorPanelView({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const [inspectorState, setInspectorState] = useReducer(
    frequencyDomainInspectorReducer,
    initialFrequencyDomainInspectorState,
  );
  const {
    calculationModeValidationMessage,
    commandMessage,
    draftCalculationMode,
    selectedEigenBranchId,
    selectedModeDataPreviewOpen,
    selectedModeDataPreviewPhaseRad,
    selectedModeDataPreviewView,
    selectedFmrPeakKey,
    selectedSpectrumModeKey,
  } = inspectorState;
  const modeDisplaySettings = useFrequencyDomainModeDisplaySettings({
    onCommandMessage: (commandMessage) => setInspectorState({ commandMessage }),
    sourceDetail: selection.kind ?? "frequency-domain",
  });
  const activeAnalysisFieldOverlay =
    modeDisplaySettings.activeAnalysisFieldOverlay;
  const modeAppearanceCommandInput =
    modeDisplaySettings.appearanceCommandInput;
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

  // C6: Sync the phase input from the overlay when animation stops or phase changes externally
  useEffect(() => {
    const overlay = activeAnalysisFieldOverlay;
    if (!overlay) return;
    const isAnimating = overlay.animation?.animatePhase === true;
    if (isAnimating) return;
    const overlayPhase = overlay.visualizationPhaseRad ?? overlay.query?.phase_rad ?? 0;
    if (analysisFieldPhaseInputRef.current) {
      analysisFieldPhaseInputRef.current.value = String(overlayPhase);
    }
  }, [
    activeAnalysisFieldOverlay,
    activeAnalysisFieldOverlay?.visualizationPhaseRad,
    activeAnalysisFieldOverlay?.animation?.animatePhase,
  ]);
  const manifest = useFrequencyDomainManifestResource();
  const data = manifest.data;
  const manifestPayload = useMemo(
    () => frequencyDomainManifestPayload(data),
    [data],
  );
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
  const cancelRequestedResourceEnabled =
    selection.kind?.includes("cancel_requested") ||
    Boolean(data?.response_cancel_requested?.partial_artifacts_available);
  const responseCancelRequested =
    useFrequencyDomainResponseCancelRequestedResource({
      enabled: cancelRequestedResourceEnabled,
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
  const manifestPhysics = record(record(manifestPayload)?.physics);
  const spectrumModel = useMemo(
    () => buildEigenSpectrumChartModel(spectrum.data),
    [spectrum.data],
  );
  const branchesModel = useMemo(
    () => buildEigenBranchesModel(branches.data),
    [branches.data],
  );
  const dispersionModel = useMemo(
    () => buildEigenDispersionChartModel(dispersion.data, branchesModel),
    [dispersion.data, branchesModel],
  );
  const responseModel = useMemo(
    () => buildFrequencyResponseChartModel(responseSweep.data, manifestPayload),
    [responseSweep.data, manifestPayload],
  );
  const responseFieldResources =
    responseFieldResourcesFromManifest(manifestPayload);
  const fmrPeakModel = useMemo(
    () =>
      buildFmrPeakTableModel({
        manifestPayload,
        responseSweep: responseSweep.data,
        spectrum: spectrum.data,
      }),
    [manifestPayload, responseSweep.data, spectrum.data],
  );
  const fmrComparisonModel = useMemo(
    () =>
      buildFmrModalDrivenComparisonModel({
        manifestPayload,
        responseSweep: responseSweep.data,
        spectrum: spectrum.data,
      }),
    [manifestPayload, responseSweep.data, spectrum.data],
  );
  const chartRoute = routeFrequencyDomainCalculationMode(manifestPayload);
  const selectedFieldMeta = responseFieldMeta.data ?? eigenModeFieldMeta.data;
  const selectedFieldId = selectedFieldMeta?.field_id ?? frequencyDomainRef?.fieldId ?? null;
  const selectedField3DStatus = selectedField3DPlotStatus(selectedFieldMeta);
  const selectedField3DReady =
    Boolean(selectedFieldId) && canPlotSelectedFieldIn3D(selectedFieldMeta);
  const selectedField3DControlTitle = selectedField3DReady
    ? "Plot selected frequency-domain field in 3D"
    : selectedField3DStatus;
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
  const activeEigenBranchId = selectedEigenBranchId ?? frequencyDomainRef?.branchId ?? null;
  const selectedBranch = branchesModel.branches.find(
    (branch) => branch.branchId === activeEigenBranchId,
  );
  const selectedObservablePoints = responseModel.points.filter(
    (point) => point.observableId === frequencyDomainRef?.observableId,
  );
  const selectedObservableFrequencies = selectedObservablePoints.map(
    (point) => point.frequencyHz,
  );
  const selectedObservableAmplitudes = selectedObservablePoints.flatMap((point) =>
    point.amplitude == null ? [] : [point.amplitude],
  );
  const modalPeakCount = fmrPeakModel.peaks.filter(
    (peak) => peak.source === "modal",
  ).length;
  const drivenPeakCount = fmrPeakModel.peaks.filter(
    (peak) => peak.source === "driven_response",
  ).length;
  const spectrumModeFieldCount = spectrumModel.points.filter(
    (point) => point.modeFieldId,
  ).length;
  const firstFmrPeak = fmrPeakModel.peaks[0] ?? null;
  const activeFmrPeak =
    fmrPeakModel.peaks.find((peak) => fmrPeakKey(peak) === selectedFmrPeakKey) ??
    firstFmrPeak;
  const activeFmrPeakMode = activeFmrPeak?.modeRef
    ? `sample ${activeFmrPeak.modeRef.sampleIndex}, mode ${activeFmrPeak.modeRef.rawModeIndex}`
    : "not a modal peak";
  const activeFmrPeakResponsePoint =
    activeFmrPeak?.frequencyPointIndex == null
      ? "not a driven peak"
      : `frequency point ${activeFmrPeak.frequencyPointIndex}`;
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
  const spectrumModeRows = spectrumModel.points.toSorted(
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
  const activeModalResonance =
    selectedSpectrumMode != null
      ? `mode ${selectedSpectrumMode.rawModeIndex} at ${formatFrequency(selectedSpectrumMode.frequencyHz)}`
      : "not selected";
  const nearestFmrComparison = fmrComparisonModel.nearestComparison;
  const nearestFmrDetuning =
    nearestFmrComparison != null
      ? `${formatFrequency(nearestFmrComparison.detuningHz)} driven-modal; modal ${formatFrequency(nearestFmrComparison.modalPeak.frequencyHz)}, driven ${formatFrequency(nearestFmrComparison.drivenPeak.frequencyHz)}`
      : fmrComparisonModel.readiness === "modal-only"
        ? "driven response missing"
        : fmrComparisonModel.readiness === "driven-only"
          ? "modal spectrum missing"
          : "not available";
  const selectedSpectrumModeOverlayStatus =
    selectedSpectrumMode?.modeFieldId
      ? "selected mode field ready"
      : "selected mode field missing";
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
    Boolean(selectedEigenModeFieldId) &&
    (canPlotSelectedFieldIn3D(selectedFieldMeta) ||
      Boolean(selectedEigenModeResourceRef));
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
  const showBoundaryWorkflow = isFrequencyDomainKind(
    kind,
    "study.stage.eigenmodes.boundary",
    "study.stage.frequency_response.boundary",
    "study.stage.eigenmodes.periodic_pairs",
    "study.stage.frequency_response.periodic_pairs",
  );
  const showKSamplingWorkflow = isFrequencyDomainKind(
    kind,
    "study.stage.eigenmodes.k_path",
    "study.stage.frequency_response.k_grid",
  );
  const showSetupAuthoring = isExactFrequencyDomainKind(
    kind,
    "study.stage.eigenmodes.setup",
    "study.stage.frequency_response.setup",
  );
  const showEquilibriumAuthoring = isExactFrequencyDomainKind(
    kind,
    "study.stage.eigenmodes.equilibrium",
    "study.stage.frequency_response.equilibrium",
  );
  const showOperatorAuthoring = isExactFrequencyDomainKind(
    kind,
    "study.stage.eigenmodes.operator",
    "study.stage.frequency_response.operator",
  );
  const isEigenmodesAuthoringNode = kind.startsWith("study.stage.eigenmodes");
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
  const showCalculationModeWorkflow = isFrequencyDomainKind(
    kind,
    "study.stage.eigenmodes.calculation_mode",
    "study.stage.frequency_response.calculation_mode",
    "results.frequency_domain.calculation_modes",
  );
  const showFrequencyDomainResourceGroup = isFrequencyDomainKind(
    kind,
    "resources.analysis.frequency_domain.calculation_modes",
    "resources.analysis.frequency_domain.fmr",
    "resources.analysis.frequency_domain.dispersion",
    "resources.analysis.frequency_domain.response_map",
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
  const showFmrSpectrumWorkbench = isFrequencyDomainKind(
    kind,
    "results.frequency_domain.fmr",
    "results.frequency_domain.fmr_modal_spectrum",
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
  const calculationModeRows = buildFrequencyDomainCalculationModeRows(
    data?.capabilities,
    data?.floquet_nonzero_k_response_supported,
  );
  const isCalculationModeAuthoring = isExactFrequencyDomainKind(
    kind,
    "study.stage.eigenmodes.calculation_mode",
    "study.stage.frequency_response.calculation_mode",
  );
  const calculationModeAuthoringKind =
    kind === "study.stage.eigenmodes.calculation_mode"
      ? "eigenmodes"
      : kind === "study.stage.frequency_response.calculation_mode"
        ? "frequency_response"
        : null;
  const defaultAuthoringCalculationMode =
    calculationModeAuthoringKind === "eigenmodes"
      ? "fmr_modal"
      : calculationModeAuthoringKind === "frequency_response"
        ? "fmr_response"
        : chartRoute.mode;
  const activeCalculationMode =
    draftCalculationMode ?? defaultAuthoringCalculationMode;
  const activeCalculationModeRow =
    calculationModeRows.find((row) => row.mode === activeCalculationMode) ??
    calculationModeRows[0]!;
  const calculationModeAuthoringRows =
    calculationModeAuthoringKind === "eigenmodes"
      ? calculationModeRows.filter((row) =>
          ["fmr_modal", "free_modes", "dispersion_modal"].includes(row.mode),
        )
      : calculationModeAuthoringKind === "frequency_response"
        ? calculationModeRows.filter((row) =>
            ["fmr_response", "response_map"].includes(row.mode),
          )
        : calculationModeRows;
  const calculationModeAuthoringTitle =
    calculationModeAuthoringKind === "eigenmodes"
      ? "Eigenmodes calculation-mode authoring"
      : calculationModeAuthoringKind === "frequency_response"
        ? "Frequency Response calculation-mode authoring"
        : "Calculation Mode Workflow";
  const activeCalculationCanonicalPatch =
    activeCalculationModeRow.canonicalStudy === "Eigenmodes"
      ? "StudyIR::Eigenmodes"
      : "StudyIR::FrequencyResponse";
  const activeCalculationRequestedFields =
    [
      activeCalculationModeRow.kRequirement,
      activeCalculationModeRow.sweepRequirement,
      activeCalculationModeRow.excitationRequirement,
      activeCalculationModeRow.artifacts,
    ].join("; ");
  const activeCalculationValidationGates =
    activeCalculationMode === "response_map"
      ? "requires nonzero-k driven response capability"
      : activeCalculationMode === "dispersion_modal"
        ? "requires periodic pairs, Floquet/Bloch k-path, and demag-k gate"
        : activeCalculationMode === "fmr_response"
          ? "requires finite positive frequency sweep and nonzero harmonic excitation"
          : "requires valid modal count, target, equilibrium, and outputs";
  const calculationModeTableRows = isCalculationModeAuthoring
    ? calculationModeAuthoringRows
    : calculationModeRows;
  const calculationModeValidationResult =
    activeCalculationModeRow.capabilityStatus.includes("unsupported")
      ? activeCalculationModeRow.capabilityStatus
      : `${activeCalculationMode} requirements are ready for the canonical stage draft.`;
  const plotModePoint = (
    point: (typeof spectrumModel.points)[number],
    action: FrequencyDomainModeTableAction = DEFAULT_ANALYSIS_FIELD_VIEW,
    options: {
      animationRateHz?: number | null;
      phaseRad?: number | null;
      view?: string | null;
    } = {},
  ): void => {
    setInspectorState({ selectedSpectrumModeKey: modePointKey(point) });
    const modeRef = buildEigenModeSelectionRef(point, {
      analysisRunId: frequencyDomainRef?.analysisRunId,
      analysisStageId: frequencyDomainRef?.analysisStageId,
      calculationMode: chartRoute.mode,
    });
    kernel.selection.set(
      {
        kind: "results.eigen.mode",
        label: `Mode ${point.rawModeIndex}`,
        nodeId: modeRef.nodeId,
        objectId: null,
        ref: modeRef,
      },
      "inspector",
    );
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
          ...modeAppearanceCommandInput(),
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
        setInspectorState({ commandMessage: result.message ?? result.status });
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
          ...modeAppearanceCommandInput(),
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
        setInspectorState({ commandMessage: result.message ?? result.status });
      });
  };
  const openSelectedEigenModeDataPreview = (): void => {
    if (!selectedEigenModeFieldId) return;
    const view = normalizeAnalysisFieldView(
      selectedEigenModeViewSelectRef.current?.value ??
        selectedFieldMeta?.default_view ??
        DEFAULT_ANALYSIS_FIELD_VIEW,
    );
    const phaseRad =
      finiteNumber(selectedEigenModePhaseInputRef.current?.value) ??
      selectedFieldMeta?.default_phase_rad ??
      0;
    setInspectorState({
      selectedModeDataPreviewOpen: true,
      selectedModeDataPreviewPhaseRad: phaseRad,
      selectedModeDataPreviewView: view,
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
        setInspectorState({ commandMessage: result.message ?? result.status });
      });
  };
  const selectResponsePoint = (
    point: (typeof responseModel.points)[number],
  ): void => {
    const responseRef = buildFrequencyResponsePointSelectionRef(point, {
      analysisRunId: frequencyDomainRef?.analysisRunId,
      analysisStageId: frequencyDomainRef?.analysisStageId,
      calculationMode: chartRoute.mode,
    });
    kernel.selection.set(
      {
        kind: responseRef.kind,
        label: `${point.observableId} ${formatFrequency(point.frequencyHz)}`,
        nodeId: responseRef.nodeId,
        objectId: null,
        ref: responseRef,
      },
      "inspector",
    );
  };
  const selectDispersionPoint = (
    point: (typeof dispersionModel.points)[number],
  ): void => {
    setInspectorState({ selectedEigenBranchId: point.branchId ?? null });
    const dispersionRef = buildEigenDispersionPointSelectionRef(point, {
      analysisRunId: frequencyDomainRef?.analysisRunId,
      analysisStageId: frequencyDomainRef?.analysisStageId,
      calculationMode: chartRoute.mode,
    });
    kernel.selection.set(
      {
        kind: dispersionRef.kind,
        label: `sample ${point.sampleIndex}, mode ${point.rawModeIndex}`,
        nodeId: dispersionRef.nodeId,
        objectId: null,
        ref: dispersionRef,
      },
      "inspector",
    );
  };
  const selectEigenBranch = (
    branch: (typeof branchesModel.branches)[number],
  ): void => {
    setInspectorState({ selectedEigenBranchId: branch.branchId });
    const branchRef = buildEigenBranchSelectionRef(branch, {
      analysisRunId: frequencyDomainRef?.analysisRunId,
      analysisStageId: frequencyDomainRef?.analysisStageId,
      calculationMode: chartRoute.mode,
    });
    kernel.selection.set(
      {
        kind: branchRef.kind,
        label: branch.label ?? `Branch ${branch.branchId}`,
        nodeId: branchRef.nodeId,
        objectId: null,
        ref: branchRef,
      },
      "inspector",
    );
  };
  const resolvePeakMode = (peak: (typeof fmrPeakModel.peaks)[number]) =>
    peak.modeRef
      ? spectrumModel.points.find(
          (point) =>
            point.sampleIndex === peak.modeRef?.sampleIndex &&
            point.rawModeIndex === peak.modeRef.rawModeIndex,
        ) ?? null
      : null;
  const resolvePeakResponsePoint = (
    peak: (typeof fmrPeakModel.peaks)[number],
  ) =>
    peak.frequencyPointIndex != null
      ? responseModel.points.find(
          (point) => point.frequencyIndex === peak.frequencyPointIndex,
        ) ?? null
      : null;
  const selectFmrPeak = (peak: (typeof fmrPeakModel.peaks)[number]): void => {
    setInspectorState({ selectedFmrPeakKey: fmrPeakKey(peak) });
    const mode = resolvePeakMode(peak);
    if (mode) {
      plotModePoint(mode, "inspect");
      return;
    }
    const responsePoint = resolvePeakResponsePoint(peak);
    if (!responsePoint) return;
    selectResponsePoint(responsePoint);
  };
  const plotFmrPeak = (peak: (typeof fmrPeakModel.peaks)[number]): void => {
    setInspectorState({ selectedFmrPeakKey: fmrPeakKey(peak) });
    const mode = resolvePeakMode(peak);
    if (mode) {
      plotModePoint(mode);
      return;
    }
    const responsePoint = resolvePeakResponsePoint(peak);
    if (responsePoint) plotResponsePoint(responsePoint);
  };

  return (
    <div className="fm-inspector-panel">
      <InspectorGroup
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
      </InspectorGroup>

      <InspectorGroup title={nodeDetail.title} badge="per-node">
        <FieldRow label="Node focus" value={nodeDetail.focus} />
        <FieldRow label="Node resource" value={nodeDetail.resource} />
        <FieldRow label="Node artifact" value={nodeDetail.artifact} />
        <FieldRow label="Visualization contract" value={nodeDetail.visualization} />
      </InspectorGroup>

      {showFamilyContract ? (
      <InspectorGroup title="Solver Family Contract" badge={data?.schema_version ?? "missing"}>
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
      </InspectorGroup>
      ) : null}

      {showPhysicsContract ? (
      <InspectorGroup
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
      </InspectorGroup>
      ) : null}

      {showPeriodicSection ? (
      <InspectorGroup
        title="Periodic / Floquet Boundary Conditions"
        badge={
          periodicPairs.data
            ? periodicStatusView(periodicPairs.data.status).label
            : periodicPairs.status
        }
      >
        <FieldRow
          label="Periodic pairs resource"
          value={frequencyDomainRef?.resourceRef ?? MESHING_PERIODIC_PAIRS_PATH}
        />
        <FieldRow
          label="Periodic pairs status"
          value={
            periodicPairs.data
              ? periodicStatusView(periodicPairs.data.status).label
              : periodicPairs.status
          }
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
      </InspectorGroup>
      ) : null}

      {showBoundaryWorkflow ? (
      <InspectorGroup title="Boundary Workflow" badge="read-only">
        <FieldRow
          label="Boundary condition"
          value={
            <select
              aria-label="Boundary condition selector"
              className="fm-inspector-select"
              defaultValue={kind.includes("k_") ? "floquet" : "free"}
              disabled
            >
              <option value="free">free/open</option>
              <option value="periodic">static periodic</option>
              <option value="floquet">Floquet/Bloch</option>
              <option value="pinned">pinned</option>
            </select>
          }
        />
        <FieldRow
          label="Periodic pair source"
          value={frequencyDomainRef?.resourceRef ?? MESHING_PERIODIC_PAIRS_PATH}
        />
        <FieldRow
          label="Floquet phase convention"
          value="exp(-i k dot delta_r)"
        />
        <FieldRow
          label="Demag policy"
          value={
            data?.floquet_nonzero_k_demag_supported
              ? "nonzero-k demag allowed"
              : "nonzero-k demag rejected"
          }
        />
        <FieldRow
          label="Status"
          value="diagnostic view; editing requires study transaction"
        />
      </InspectorGroup>
      ) : null}

      {showKSamplingWorkflow ? (
      <InspectorGroup title="k-Sampling Workflow" badge="read-only">
        <FieldRow
          label="k sampling mode"
          value={
            <select
              aria-label="k sampling mode"
              className="fm-inspector-select"
              defaultValue={
                kind === "study.stage.frequency_response.k_grid"
                  ? "k_frequency_grid"
                  : "k_path"
              }
              disabled
            >
              <option value="k0">k = 0</option>
              <option value="k_path">1D k-path</option>
              <option value="k_frequency_grid">k/f response grid</option>
            </select>
          }
        />
        {kind === "study.stage.frequency_response.k_grid" ? (
          <>
            <FieldRow
              label="k-grid nx"
              value={
                <input
                  aria-label="k-grid nx"
                  className="fm-inspector-input"
                  defaultValue="21"
                  disabled
                  min="1"
                  step="1"
                  type="number"
                />
              }
            />
            <FieldRow
              label="k-grid ny"
              value={
                <input
                  aria-label="k-grid ny"
                  className="fm-inspector-input"
                  defaultValue="1"
                  disabled
                  min="1"
                  step="1"
                  type="number"
                />
              }
            />
            <FieldRow label="Frequency coupling" value="sweep x k-grid" />
          </>
        ) : (
          <>
            <FieldRow label="Path endpoint A" value="Gamma" />
            <FieldRow label="Path endpoint B" value="X" />
            <FieldRow
              label="k sample count"
              value={
                <input
                  aria-label="k sample count"
                  className="fm-inspector-input"
                  defaultValue="41"
                  disabled
                  min="2"
                  step="1"
                  type="number"
                />
              }
            />
          </>
        )}
        <FieldRow label="k units" value="rad/m" />
        <FieldRow
          label="Status"
          value="diagnostic view; editing requires study transaction"
        />
      </InspectorGroup>
      ) : null}

      {showSetupAuthoring ? (
      <InspectorGroup
        title={
          isEigenmodesAuthoringNode
            ? "Eigenmodes setup authoring"
            : "Frequency Response setup authoring"
        }
        badge="stage draft"
      >
        {isEigenmodesAuthoringNode ? (
          <>
            <FieldRow
              label="Mode count"
              value="positive integer; edit in Study stage draft"
            />
            <FieldRow
              label="Target kind"
              value="lowest / nearest / frequency window"
            />
            <FieldRow
              label="Target frequency"
              value="stored in Hz; display may use MHz/GHz"
            />
            <FieldRow
              label="Operator preset"
              value="linearized LLG, tangent-space projected"
            />
            <FieldRow label="Requested backend" value="fem" />
            <FieldRow label="Requested device" value="cpu" />
            <FieldRow label="Requested precision" value="double" />
          </>
        ) : (
          <>
            <FieldRow label="Direct harmonic response" value="enabled" />
            <FieldRow label="No time integrator" value="frequency-domain solve" />
            <FieldRow
              label="Frequency count"
              value="explicit positive values_hz list; helpers generate list in Study stage draft"
            />
            <FieldRow label="Response outputs" value="susceptibility, response field, FMR peaks" />
            <FieldRow label="Requested backend" value="fem" />
            <FieldRow label="Requested device" value="cpu" />
            <FieldRow label="Requested precision" value="double" />
          </>
        )}
        <FieldRow
          label="Canonical stage draft"
          value="Use the Study stage inspector draft editor"
        />
        <FieldRow label="Draft commit path" value="Save stage commits setup fields through the canonical stage patch" />
      </InspectorGroup>
      ) : null}

      {showEquilibriumAuthoring ? (
      <InspectorGroup
        title={
          isEigenmodesAuthoringNode
            ? "Eigenmodes equilibrium authoring"
            : "Frequency Response equilibrium authoring"
        }
        badge="stage draft"
      >
        <FieldRow
          label="Equilibrium source"
          value="provided / relaxed_initial_state / artifact(path)"
        />
        <FieldRow
          label="Artifact path"
          value={frequencyDomainRef?.artifactPath ?? "stage://equilibrium/m0"}
        />
        <FieldRow label="m0 x H0 residual" value="< tolerance before solve" />
        <FieldRow label="Normalization error" value="max |m0|-1 residual" />
        {isEigenmodesAuthoringNode ? null : (
          <FieldRow
            label="Modal comparison ready"
            value="requires the same equilibrium artifact as modal solve"
          />
        )}
        <FieldRow
          label="Canonical stage draft"
          value="Use the Study stage inspector draft editor"
        />
        <FieldRow label="Draft commit path" value="Save stage commits equilibrium source through the canonical stage patch" />
      </InspectorGroup>
      ) : null}

      {showOperatorAuthoring ? (
      <InspectorGroup
        title={
          isEigenmodesAuthoringNode
            ? "Eigenmodes operator authoring"
            : "Frequency Response operator authoring"
        }
        badge="stage draft"
      >
        <FieldRow
          label="Operator kind"
          value={
            isEigenmodesAuthoringNode
              ? "generalized eigenproblem"
              : "complex harmonic linear system"
          }
        />
        <FieldRow label="Include demag" value="yes, backend capability gated" />
        <FieldRow
          label="Damping policy"
          value={isEigenmodesAuthoringNode ? "reported for linewidth" : "included in response operator"}
        />
        <FieldRow label="Normalization" value="tangent-space modal norm" />
        {isEigenmodesAuthoringNode ? (
          <FieldRow label="Energy terms" value="exchange, demag, anisotropy, Zeeman, DMI when enabled" />
        ) : (
          <FieldRow label="Production CPU slice" value="MFEM/hypre complex solve per frequency" />
        )}
        <FieldRow
          label="Canonical stage draft"
          value="Use the Study stage inspector draft editor"
        />
        <FieldRow label="Draft commit path" value="Save stage commits operator options through the canonical stage patch" />
      </InspectorGroup>
      ) : null}

      <FrequencyDomainResponseSection
        selection={selection}
        inspectorState={inspectorState}
        setInspectorState={setInspectorState}
        data={data}
        responseSweep={responseSweep}
      />

      {showResponseFields ? (
      <InspectorGroup
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
      </InspectorGroup>
      ) : null}

      {showResponseCancellation ? (
      <InspectorGroup
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
      </InspectorGroup>
      ) : null}

      <FrequencyDomainEigenSection
        selection={selection}
        inspectorState={inspectorState}
        setInspectorState={setInspectorState}
        data={data}
        spectrum={spectrum}
        branches={branches}
        dispersion={dispersion}
      />

      {showCalculationModeWorkflow ? (
      <InspectorGroup
        title={calculationModeAuthoringTitle}
        badge={activeCalculationMode}
      >
        <FieldRow
          label="Workflow preset"
          value={
            isCalculationModeAuthoring ? (
              <select
                aria-label="Workflow mode"
                className="fm-inspector-select"
                value={activeCalculationMode}
                onChange={(event) =>
                  setInspectorState({ draftCalculationMode: event.currentTarget.value })
                }
              >
                {calculationModeAuthoringRows.map((row) => (
                  <option key={row.mode} value={row.mode}>
                    {row.mode}
                  </option>
                ))}
              </select>
            ) : (
              chartRoute.mode
            )
          }
        />
        <FieldRow
          label="Canonical patch preview"
          value={activeCalculationCanonicalPatch}
        />
        <FieldRow
          label="Requested fields"
          value={activeCalculationRequestedFields}
        />
        <FieldRow
          label="Validation gates"
          value={activeCalculationValidationGates}
        />
        <FieldRow
          label="Capability reason"
          value={activeCalculationModeRow.capabilityStatus}
        />
        <FieldRow
          label="Python export"
          value={`${activeCalculationModeRow.canonicalStudy} DSL, not a UI-only enum`}
        />
        {isCalculationModeAuthoring ? null : (
          <>
            <FieldRow label="Resolved route" value={chartRoute.mode} />
            <FieldRow label="Primary chart" value={chartRoute.primaryChart} />
          </>
        )}
        <FieldRow
          label="Workflow options"
          value={calculationModeAuthoringRows.map((row) => row.mode).join(", ")}
        />
        <FieldRow
          label="Boundary preset"
          value={activeCalculationModeRow.boundaryPreset}
        />
        <FieldRow
          label="k requirement"
          value={activeCalculationModeRow.kRequirement}
        />
        <FieldRow
          label="Sweep requirement"
          value={activeCalculationModeRow.sweepRequirement}
        />
        <FieldRow
          label="Excitation requirement"
          value={activeCalculationModeRow.excitationRequirement}
        />
        <FieldRow
          label="Required artifacts"
          value={activeCalculationModeRow.artifacts}
        />
        <FieldRow
          label="Canonical stage draft"
          value="Use the Study stage inspector draft editor"
        />
        <FieldRow
          label="Draft commit path"
          value={
            isCalculationModeAuthoring
              ? "Save stage commits calculation_mode through the canonical stage patch"
              : "result route summary; use stage calculation-mode node for editing"
          }
        />
        {isCalculationModeAuthoring ? (
          <>
            <FieldRow
              label="Draft status"
              value={
                draftCalculationMode
                  ? `${draftCalculationMode} selected for stage draft`
                  : "using canonical default workflow"
              }
            />
            {calculationModeValidationMessage ? (
              <FieldRow
                label="Validation check"
                value={calculationModeValidationMessage}
              />
            ) : null}
            <div className="fm-inspector-toolbar">
              <Button
                size="sm"
                title="Apply the selected calculation mode to the stage draft"
                type="button"
                variant="primary"
                onClick={() => {
                  setInspectorState({
                    calculationModeValidationMessage: `${activeCalculationMode} applied to the local stage draft.`,
                    draftCalculationMode: activeCalculationMode,
                  });
                }}
              >
                <CheckCircle2 size={13} aria-hidden="true" />
                Apply calculation mode
              </Button>
              <Button
                size="sm"
                title="Validate current calculation-mode requirements"
                type="button"
                variant="secondary"
                onClick={() => {
                  setInspectorState({
                    calculationModeValidationMessage:
                      calculationModeValidationResult,
                  });
                }}
              >
                Validate calculation mode
              </Button>
            </div>
          </>
        ) : null}
        <div className="fm-frequency-domain-table-wrap">
          <table className="fm-frequency-domain-table">
            <thead>
              <tr>
                <th>Workflow mode</th>
                <th>Canonical study</th>
                <th>Boundary preset</th>
                <th>k requirement</th>
                <th>Sweep requirement</th>
                <th>Excitation requirement</th>
                <th>Required artifacts</th>
                <th>Capability status</th>
              </tr>
            </thead>
            <tbody>
              {calculationModeTableRows.map((row) => (
                <tr key={row.mode}>
                  <td>{row.mode}</td>
                  <td>{row.canonicalStudy}</td>
                  <td>{row.boundaryPreset}</td>
                  <td>{row.kRequirement}</td>
                  <td>{row.sweepRequirement}</td>
                  <td>{row.excitationRequirement}</td>
                  <td>{row.artifacts}</td>
                  <td>{row.capabilityStatus}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </InspectorGroup>
      ) : null}

      {showFrequencyDomainResourceGroup ? (
      <InspectorGroup title="Frequency-Domain Resource Group" badge="resources">
        <FieldRow
          label="Resource group"
          value={frequencyDomainResourceGroupLabel(kind)}
        />
        <FieldRow label="Resource focus" value={nodeDetail.focus} />
        <FieldRow
          label="Manifest resource"
          value={ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH}
        />
        <FieldRow
          label="Modal spectrum resource"
          value={
            spectrum.data?.status === "ready"
              ? ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH
              : "not available"
          }
        />
        <FieldRow
          label="Driven sweep resource"
          value={
            responseSweep.data?.status === "ready"
              ? ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH
              : "not available"
          }
        />
        <FieldRow
          label="Dispersion resource"
          value={
            dispersion.data?.status === "ready"
              ? ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH
              : "not available"
          }
        />
        <FieldRow
          label="Branch resource"
          value={
            branches.data?.status === "ready"
              ? ANALYSIS_FREQUENCY_DOMAIN_EIGEN_BRANCHES_V2_PATH
              : "not available"
          }
        />
        <FieldRow
          label="FMR peak table"
          value={`${fmrPeakModel.peaks.length} peak(s)`}
        />
        <FieldRow
          label="k-path chart"
          value={
            dispersionModel.points.length > 0
              ? `${dispersionModel.points.length} point(s)`
              : "not available"
          }
        />
        <FieldRow
          label="Response map gate"
          value={
            data?.floquet_nonzero_k_response_supported
              ? "nonzero-k response available"
              : "nonzero-k response unavailable"
          }
        />
        <FieldRow
          label="Available charts"
          value={[
            spectrumModel.points.length > 0 ? "modal spectrum" : null,
            responseModel.points.length > 0 ? "driven sweep" : null,
            dispersionModel.points.length > 0 ? "dispersion" : null,
          ]
            .filter((item): item is string => item != null)
            .join(", ") || "not available"}
        />
      </InspectorGroup>
      ) : null}

      {showKPath ? (
      <InspectorGroup title="Bloch k-Path Parameters" badge={dispersion.status}>
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
      </InspectorGroup>
      ) : null}

      {showEigenModeBrowser ? (
      <InspectorGroup
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
                    value={modePointKey(selectedSpectrumMode)}
                    onChange={(event) => {
                      setInspectorState({ selectedSpectrumModeKey: event.currentTarget.value });
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
              label="Visualization style scope"
              value="one shared preset for all modes in this result"
            />
            <FieldRow
              label="Mode switch behavior"
              value="change active field only; keep shader, vector, color, phase, and colormap controls"
            />
            <FieldRow
              label="Volume inspection roadmap"
              value="clip planes and shader opacity are planned for internal-mode inspection"
            />
            <FrequencyDomainModeDisplayControls
              disabled={!selectedSpectrumMode.modeFieldId}
              labelPrefix="Eigen mode browser"
              settings={modeDisplaySettings}
              viewDefaultValue={DEFAULT_ANALYSIS_FIELD_VIEW}
              viewOptions={ANALYSIS_FIELD_VIEW_OPTIONS}
              viewRef={eigenModeBrowserViewSelectRef}
            />
            <FieldRow
              label="Phase"
              value={
                <input
                  aria-label="Eigen mode browser phase"
                  className="fm-inspector-input"
                  defaultValue="0"
                  disabled={!selectedSpectrumMode.modeFieldId}
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
                  max="10"
                  min="0.05"
                  ref={eigenModeBrowserAnimationRateInputRef}
                  step="0.05"
                  type="number"
                />
              }
            />
            <div
              aria-label="Eigen mode 3D visualization controls"
              className="fm-frequency-domain-visualization-actions"
            >
              {EIGEN_MODE_BROWSER_ACTIONS.map((entry) => {
                const Icon = entry.icon;
                return (
                  <Button
                    aria-label={entry.title}
                    className="fm-inspector-action-button"
                    disabled={!selectedSpectrumMode.modeFieldId}
                    key={entry.action}
                    size="sm"
                    title={
                      selectedSpectrumMode.modeFieldId
                        ? entry.title
                        : "Selected eigen mode has no 3D field artifact"
                    }
                    type="button"
                    variant={entry.variant}
                    onClick={() => plotSelectedSpectrumMode(entry.action)}
                  >
                    <Icon size={13} aria-hidden="true" />
                    <span>{entry.label}</span>
                  </Button>
                );
              })}
            </div>
          </>
        ) : null}
      </InspectorGroup>
      ) : null}

      {showSelectedField ? (
      <InspectorGroup title="Selected Field Metadata" badge={selectedFieldStatus}>
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
        <FrequencyDomainModeDisplayControls
          disabled={!selectedField3DReady}
          key={`${selectedFieldId ?? "none"}:${selectedFieldViewOptionsKey}:${defaultAnalysisFieldView}`}
          labelPrefix="Frequency-domain mode"
          settings={modeDisplaySettings}
          viewDefaultValue={defaultAnalysisFieldView}
          viewOptions={selectedFieldViewOptions}
          viewRef={analysisFieldViewSelectRef}
          viewTitle={selectedField3DControlTitle}
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
              title={selectedField3DControlTitle}
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
              title={selectedField3DControlTitle}
              type="number"
            />
          }
        />
        <Button
          aria-label="Plot selected frequency-domain field in 3D"
          disabled={!selectedField3DReady}
          size="sm"
          title={selectedField3DControlTitle}
          type="button"
          variant="primary"
          onClick={() => {
            void kernel.commands
              .execute(
                selectedFieldPlotCommand,
                createCommandContext("inspector", kernel, {
                  sourceDetail: selection.kind ?? "frequency-domain",
                }),
                {
                  ...modeAppearanceCommandInput(),
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
                setInspectorState({ commandMessage: result.message ?? result.status });
              });
          }}
        >
          Plot in 3D
        </Button>
        {["phase_rotated_real", "real", "imag", "abs", "phase"].map((view) => (
          <Button
            aria-label={`Plot selected frequency-domain field ${analysisFieldViewLabel(view)}`}
            disabled={!selectedField3DReady}
            key={view}
            size="sm"
            title={
              selectedField3DReady
                ? `Plot selected frequency-domain field ${analysisFieldViewLabel(view)}`
                : selectedField3DControlTitle
            }
            type="button"
            onClick={() => {
              void kernel.commands
                .execute(
                  selectedFieldPlotCommand,
                  createCommandContext("inspector", kernel, {
                    sourceDetail: selection.kind ?? "frequency-domain",
                }),
                {
                    ...modeAppearanceCommandInput(),
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
                  setInspectorState({ commandMessage: result.message ?? result.status });
                });
            }}
          >
            {view === "phase_rotated_real"
              ? "Plot rotated"
              : `Plot ${view}`}
          </Button>
        ))}
        <Button
          aria-label="Set selected frequency-domain field phase"
          disabled={!selectedField3DReady}
          size="sm"
          title={
            selectedField3DReady
              ? "Set selected frequency-domain field phase"
              : selectedField3DControlTitle
          }
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
                setInspectorState({ commandMessage: result.message ?? result.status });
              });
          }}
        >
          Set phase
        </Button>
        <Button
          aria-label="Animate selected frequency-domain field phase"
          disabled={!selectedField3DReady}
          size="sm"
          title={
            selectedField3DReady
              ? "Animate selected frequency-domain field phase"
              : selectedField3DControlTitle
          }
          type="button"
          onClick={() => {
            void kernel.commands
              .execute(
                selectedFieldAnimationCommand,
                createCommandContext("inspector", kernel, {
                  sourceDetail: selection.kind ?? "frequency-domain",
                }),
                {
                  ...modeAppearanceCommandInput(),
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
                setInspectorState({ commandMessage: result.message ?? result.status });
              });
          }}
        >
          Animate field phase
        </Button>
        <Button
          aria-label="Stop selected frequency-domain field animation"
          disabled={!activeAnalysisFieldOverlay?.animation?.animatePhase}
          size="sm"
          title={
            activeAnalysisFieldOverlay?.animation?.animatePhase
              ? "Stop selected frequency-domain field animation"
              : "No frequency-domain field animation is active"
          }
          type="button"
          onClick={() => {
            void kernel.commands
              .execute(
                "analysis.frequency-domain.stop-3d-animation",
                createCommandContext("inspector", kernel, {
                  sourceDetail: selection.kind ?? "frequency-domain",
                }),
              )
              .then((result) => {
                setInspectorState({ commandMessage: result.message ?? result.status });
              });
          }}
        >
          Stop animate
        </Button>
        <Button
          aria-label="Clear frequency-domain 3D field"
          size="sm"
          title="Clear frequency-domain 3D field"
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
                setInspectorState({ commandMessage: result.message ?? result.status });
              });
          }}
        >
          Clear 3D field
        </Button>
        {commandMessage ? (
          <FieldRow label="3D command" value={commandMessage} />
        ) : null}
      </InspectorGroup>
      ) : null}

      {showSelectedEigenMode ? (
      <InspectorGroup
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
          label="Shared mode visualization preset"
          value="shared across all eigen modes in this result"
        />
        <FieldRow
          label="Mode switch behavior"
          value="changes field payload only; keeps shader, vector, color, phase, and colormap controls"
        />
        <FrequencyDomainModeDisplayControls
          disabled={!selectedEigenMode3DReady}
          labelPrefix="Selected eigen mode"
          settings={modeDisplaySettings}
          viewDefaultValue={defaultAnalysisFieldView}
          viewOptions={selectedFieldViewOptions}
          viewRef={selectedEigenModeViewSelectRef}
        />
        <FieldRow
          label="Mode phase"
          value={
            <input
              aria-label="Selected eigen mode phase"
              className="fm-inspector-input"
              defaultValue={String(selectedFieldMeta?.default_phase_rad ?? 0)}
              disabled={!selectedEigenMode3DReady}
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
              max="10"
              min="0.05"
              ref={selectedEigenModeAnimationRateInputRef}
              step="0.05"
              type="number"
            />
          }
        />
        <div
          aria-label="Selected eigen mode 3D visualization controls"
          className="fm-frequency-domain-visualization-actions"
        >
          {EIGEN_MODE_BROWSER_ACTIONS.map((entry) => {
            const Icon = entry.icon;

            return (
              <Button
                aria-label={entry.title}
                className="fm-inspector-action-button"
                disabled={!selectedEigenMode3DReady}
                key={entry.action}
                size="sm"
                title={entry.title}
                type="button"
                variant={entry.variant}
                onClick={() => plotSelectedEigenModeField(entry.action)}
              >
                <Icon aria-hidden="true" size={13} />
                <span>{entry.label}</span>
              </Button>
            );
          })}
          <Button
            aria-label="Open selected eigen mode data preview"
            className="fm-frequency-domain-mode-data-preview-button"
            disabled={!selectedEigenModeFieldId}
            size="icon"
            title="Mode data preview"
            type="button"
            variant="ghost"
            onClick={openSelectedEigenModeDataPreview}
          >
            <Info aria-hidden="true" size={14} />
          </Button>
        </div>
        {selectedModeDataPreviewOpen ? (
          <FrequencyDomainModeDataPreviewDialog
            fieldId={selectedEigenModeFieldId}
            fieldMeta={selectedFieldMeta}
            onOpenChange={(open) =>
              setInspectorState({ selectedModeDataPreviewOpen: open })
            }
            open={selectedModeDataPreviewOpen}
            phaseRad={selectedModeDataPreviewPhaseRad}
            view={selectedModeDataPreviewView}
          />
        ) : null}
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
      </InspectorGroup>
      ) : null}

      {showSelectedBranch ? (
      <InspectorGroup
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
              ? formatFrequencyRangeBoundsHz(
                  selectedBranch.frequencyMinHz,
                  selectedBranch.frequencyMaxHz,
                )
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
        <FrequencyDomainBranchTable
          branches={branchesModel.branches}
          selectedBranchId={activeEigenBranchId}
          onSelectBranch={selectEigenBranch}
        />
        {branches.error ? (
          <FieldRow
            label="Branch resource error"
            value={formatError(branches.error)}
          />
        ) : null}
      </InspectorGroup>
      ) : null}

      {showSelectedResponsePoint ? (
      <InspectorGroup
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
      </InspectorGroup>
      ) : null}

      {showSelectedObservable ? (
      <InspectorGroup
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
      </InspectorGroup>
      ) : null}

      {showFmrSpectrumWorkbench ? (
      <InspectorGroup title="FMR Spectrum Workbench" badge={chartRoute.mode}>
        <FieldRow
          label="Active modal resonance"
          value={activeModalResonance}
        />
        <FieldRow
          label="Modal modes"
          value={`${spectrumModel.points.length} modes, ${spectrumModeFieldCount} field payloads`}
        />
        <FieldRow
          label="FMR peaks"
          value={`${modalPeakCount} modal, ${drivenPeakCount} driven`}
        />
        <FieldRow
          label="Field readiness"
          value={selectedSpectrumModeOverlayStatus}
        />
        <FieldRow
          label="Driven comparison"
          value={
            responseModel.points.length > 0
              ? "response sweep available"
              : "response sweep missing"
          }
        />
        <FieldRow
          label="Nearest modal-driven detuning"
          value={nearestFmrDetuning}
        />
        <FieldRow
          label="Primary chart route"
          value={`${chartRoute.primaryChart} (${chartRoute.status})`}
        />
      </InspectorGroup>
      ) : null}

      {showFmrPeaks ? (
      <InspectorGroup title="FMR Peaks" badge={fmrPeakModel.peaks.length > 0 ? "ready" : "missing"}>
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
        {activeFmrPeak ? (
          <div
            aria-label="Active FMR Peak"
            className="fm-frequency-domain-active-peak"
          >
            <div className="fm-frequency-domain-active-peak__header">
              <h4>Active FMR Peak</h4>
              <Badge variant="secondary">
                {activeFmrPeak.source}
              </Badge>
            </div>
            <FieldRow
              label="Active peak"
              value={
                <select
                  aria-label="Active FMR peak"
                  className="fm-inspector-select"
                  value={fmrPeakKey(activeFmrPeak)}
                  onChange={(event) => {
                    setInspectorState({ selectedFmrPeakKey: event.currentTarget.value });
                  }}
                >
                  {fmrPeakModel.peaks.map((peak) => (
                    <option key={fmrPeakKey(peak)} value={fmrPeakKey(peak)}>
                      {fmrPeakLabel(peak)}
                    </option>
                  ))}
                </select>
              }
            />
            <FieldRow label="Peak source" value={activeFmrPeak.source} />
            <FieldRow
              label="Peak frequency"
              value={formatFrequency(activeFmrPeak.frequencyHz)}
            />
            <FieldRow label="Modal provenance" value={activeFmrPeakMode} />
            <FieldRow
              label="Driven provenance"
              value={activeFmrPeakResponsePoint}
            />
            <FieldRow
              label="3D field artifact"
              value={activeFmrPeak.fieldId ?? "not available"}
            />
            <FieldRow
              label="Validation"
              value={activeFmrPeak.validationStatus}
            />
            <div className="fm-frequency-domain-table__actions">
              <Button
                size="sm"
                type="button"
                variant="secondary"
                onClick={() => selectFmrPeak(activeFmrPeak)}
              >
                Select active peak
              </Button>
              <Button
                disabled={!activeFmrPeak.fieldId}
                size="sm"
                title={
                  activeFmrPeak.fieldId
                    ? "Plot the active FMR peak field in 3D"
                    : "The active FMR peak has no field artifact"
                }
                type="button"
                variant="primary"
                onClick={() => plotFmrPeak(activeFmrPeak)}
              >
                Plot active peak 3D
              </Button>
            </div>
          </div>
        ) : null}
        <FrequencyDomainFmrPeakTable
          onPlotPeak={plotFmrPeak}
          onSelectPeak={selectFmrPeak}
          peaks={fmrPeakModel.peaks}
        />
      </InspectorGroup>
      ) : null}

      {showModalSpectrum ? (
      <InspectorGroup title="Modal Spectrum" badge={spectrum.data?.status ?? spectrum.status}>
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
        <FrequencyDomainSpectrumChart
          model={spectrumModel}
          onPlotMode={(point) => plotModePoint(point, "phase_rotated_real")}
          onSelectMode={(point) => plotModePoint(point, "inspect")}
          selectedModeKey={
            selectedSpectrumMode ? modePointKey(selectedSpectrumMode) : null
          }
        />
        <FrequencyDomainModeTable
          points={spectrumModel.points}
          selectedModeKey={
            selectedSpectrumMode ? modePointKey(selectedSpectrumMode) : null
          }
          onPlotMode={plotModePoint}
        />
        <FieldRow
          label="Spectrum resource"
          value={spectrum.data?.status ?? spectrum.status}
        />
      </InspectorGroup>
      ) : null}

      {showDispersionChart ? (
      <InspectorGroup title="Dispersion Chart" badge={dispersion.status}>
        <FieldRow
          label="Dispersion"
          value={`${dispersionModel.points.length} points, ${dispersionModel.series.length} series`}
        />
        <FrequencyDomainDispersionChart
          model={dispersionModel}
          onSelectPoint={selectDispersionPoint}
        />
        <FrequencyDomainBranchTable
          branches={branchesModel.branches}
          selectedBranchId={activeEigenBranchId}
          onSelectBranch={selectEigenBranch}
        />
      </InspectorGroup>
      ) : null}

      {showDrivenResponseChart ? (
      <InspectorGroup title="Driven Response Chart" badge={responseSweep.data?.status ?? responseSweep.status}>
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
        <FrequencyDomainResponseChart
          model={responseModel}
          onPlotPoint={plotResponsePoint}
          onSelectPoint={selectResponsePoint}
        />
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
      </InspectorGroup>
      ) : null}
    </div>
  );
}
