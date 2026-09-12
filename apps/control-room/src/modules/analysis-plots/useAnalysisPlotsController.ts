"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useDynamicStructureFactorResource, useSpinWaveGammaResource } from "@/kernel/resources/spinWaveResources";
import { useSelectionSelector } from "@/kernel/selection/useSelection";
import type { Selection } from "@/kernel/selection/selectionTypes";
import type { KernelApi } from "@/kernel/types";
import { analysisWorkspaceStore } from "@/kernel/workspace/analysisWorkspace";
import {
  ANALYSIS_SUBVIEWS,
  analysisDescriptorId,
  type AnalysisDescriptorPreference,
  type AnalysisSubview,
} from "@/kernel/workspace/analysisViewPreferences";
import { useAnalysisViewPreferencesHydration } from "@/kernel/workspace/useAnalysisViewPreferencesHydration";
import { useAnalysisWorkspaceSelector } from "@/kernel/workspace/useAnalysisWorkspace";

import { useAnalysisDatasetData } from "./hooks/useAnalysisDatasetData";
import { ANALYSIS_COMPARISON_UNAVAILABLE_REASON } from "./analysisComparison";
import {
  useAnalysisFrequencyData,
  type AnalysisFrequencyDataResult,
} from "./hooks/useAnalysisFrequencyData";
import type { AnalysisChartCursorPoint } from "@/shared/domain/analysis/chartCursorPoint";
import type { ChartValueRange } from "./chartTableModel";
import type { ChartDataPresentationState } from "@/shared/analysis-charts/chartPresentationState";
import type { FrequencyDomainResultContext } from "@/shared/domain/analysis/frequencyDomainChartModels";

const EMPTY_DISPLAY_UNITS: Record<string, string> = {};
const EMPTY_STRING_LIST: readonly string[] = Object.freeze([]);

export function useAnalysisPlotsController(kernel: KernelApi) {
  const activeSurface = useAnalysisWorkspaceSelector((state) => state.activeSurface);
  const selectedDatasetRef = useAnalysisWorkspaceSelector((state) => state.selectedDatasetRef);
  const sourceChartId = useAnalysisWorkspaceSelector((state) => state.sourceChartId);
  const hasChartState = useAnalysisWorkspaceSelector((state) => state.hasChartState);
  const selectedSeriesIds = useAnalysisWorkspaceSelector((state) => state.selectedSeriesIds);
  const xAxisId = useAnalysisWorkspaceSelector((state) => state.xAxisId);
  const preferences = useAnalysisViewPreferencesHydration();
  const {
    setActiveSurface: setPreferenceActiveSurface,
    setActiveSubview: setPreferenceActiveSubview,
    setDescriptorPreference,
    setSelectedDatasetRef: setPreferenceDatasetRef,
  } = preferences;
  const applied = useRef(false);
  useEffect(() => {
    if (!preferences.isHydrated || applied.current) return;
    applied.current = true;
    analysisWorkspaceStore.setActiveSurface(preferences.preferences.activeSurface);
    analysisWorkspaceStore.setSelectedDatasetRef(preferences.preferences.selectedDatasetRef);
  }, [preferences.isHydrated, preferences.preferences.activeSurface, preferences.preferences.selectedDatasetRef]);

  const activeSubview = preferences.preferences.activeSubviews?.[activeSurface] ?? ANALYSIS_SUBVIEWS[activeSurface][0];
  const subviews = ANALYSIS_SUBVIEWS[activeSurface];
  const dataset = useAnalysisDatasetData({ datasetRef: selectedDatasetRef, enabled: activeSurface === "dynamics" });
  useEffect(() => { analysisWorkspaceStore.setVisibleDatasetRevision(dataset.visibleRevision); }, [dataset.visibleRevision]);
  const frequency = useAnalysisFrequencyData(
    activeSurface === "resonance-fmr" || activeSurface === "dispersion" ? activeSurface : "idle",
    activeSubview,
  );
  const frequencyChartId = (activeSurface === "resonance-fmr" || activeSurface === "dispersion") && frequency.frequencyDomainSeries[0]
    ? `${activeSurface}:${frequency.frequencyDomainSeries[0].source.resourceKey}`
    : null;
  useEffect(() => {
    if (activeSurface === "resonance-fmr" || activeSurface === "dispersion") {
      analysisWorkspaceStore.setFocusedChartId(frequencyChartId);
      return;
    }
    if (activeSurface === "comparison") {
      analysisWorkspaceStore.setFocusedChartId(null);
      return;
    }
    analysisWorkspaceStore.setFocusedChartId(sourceChartId);
  }, [activeSurface, frequencyChartId, sourceChartId]);
  const gamma = useSpinWaveGammaResource(
    activeSurface === "dynamics" && activeSubview === "dynamics.temporal-fft",
  );
  const dynamicStructureFactor = useDynamicStructureFactorResource(
    activeSurface === "dynamics" && activeSubview === "dynamics.s-k-f",
  );
  const selectedStageId = useSelectionSelector(selectedHysteresisStageIdFromSelection);
  const [selectedPoint, setSelectedPoint] = useState<AnalysisChartCursorPoint | null>(null);
  const descriptorId = useMemo(
    () => analysisDescriptorId({ kind: "dataset", surface: activeSurface, datasetRef: selectedDatasetRef }),
    [activeSurface, selectedDatasetRef],
  );
  const descriptor = preferences.preferences.descriptorPreferences[descriptorId];
  const frequencyDescriptorId = frequencyChartId
    ? analysisDescriptorId({ kind: "artifact", surface: activeSurface === "dispersion" ? "dispersion" : "resonance-fmr", resourceKey: frequency.frequencyDomainSeries[0]!.source.resourceKey })
    : null;
  const frequencyDescriptor = frequencyDescriptorId
    ? preferences.preferences.descriptorPreferences[frequencyDescriptorId]
    : undefined;
  const tableDefaultSeriesIds = useMemo(
    () => dataset.visibleTable
      ? dataset.visibleTable.columns.slice(1).map((column) => `data.table:${dataset.visibleTable!.tableId}:${dataset.visibleTable!.columns[0]?.column_id ?? "x"}:${column.column_id}`)
      : selectedSeriesIds,
    [dataset.visibleTable, selectedSeriesIds],
  );
  const effectiveSelectedSeriesIds = useMemo(
    () => frequencyChartId
      ? frequencyDescriptor?.selectedSeriesIds ?? frequency.frequencyDomainSeries.map((series) => series.id)
      : selectedSeriesIds,
    [frequencyDescriptor?.selectedSeriesIds, frequency.frequencyDomainSeries, frequencyChartId, selectedSeriesIds],
  );
  const effectiveDescriptor = frequencyDescriptorId
    ? frequencyDescriptor
    : descriptor;
  const effectiveDescriptorSelection = useMemo(
    () => frequencyDescriptorId
      ? effectiveSelectedSeriesIds
      : descriptor?.selectedSeriesIds ?? tableDefaultSeriesIds,
    [descriptor?.selectedSeriesIds, effectiveSelectedSeriesIds, frequencyDescriptorId, tableDefaultSeriesIds],
  );
  const activeDescriptorId = frequencyDescriptorId ?? descriptorId;
  const activeDescriptorDisplayUnits = effectiveDescriptor?.displayUnits ?? EMPTY_DISPLAY_UNITS;
  const activeDescriptorRange = effectiveDescriptor?.range ?? null;
  const datasetRefs = useMemo(
    () => dataset.tableList.data?.tables.map((table) => table.table_id) ?? EMPTY_STRING_LIST,
    [dataset.tableList.data],
  );
  const frequencyDomainProvenance = useMemo(
    () => frequency.frequencyDomainSeries[0]
      ? `${frequency.frequencyDomainSeries[0].source.resourceKey} · revision ${frequency.frequencyDomainSeries[0].dataRevision}`
      : null,
    [frequency.frequencyDomainSeries],
  );
  const surfaceProvenance = useMemo(
    () => ({
      dispersion: dynamicStructureFactor.data
        ? `${dynamicStructureFactor.data.artifact_ref} · revision ${dynamicStructureFactor.data.schema_version}`
        : undefined,
      hysteresis: selectedStageId ? `hysteresis · ${selectedStageId}` : undefined,
      dynamics: gamma.data ? `spin-wave-gamma · revision ${gamma.data.schema_version}` : undefined,
    }),
    [dynamicStructureFactor.data, gamma.data, selectedStageId],
  );
  const visibleRange = useMemo(
    () => activeDescriptorRange
      ? { fromValue: activeDescriptorRange.fromSI, toValue: activeDescriptorRange.toSI }
      : null,
    [activeDescriptorRange],
  );
  const frequencyResultContext = frequency.frequencyDomainPresentation?.physicalContext;
  const frequencyArtifactRevision = analysisPresentationRevision(
    frequency.frequencyDomainPresentation,
  );
  useEffect(() => {
    analysisWorkspaceStore.setActiveDescriptorId(activeDescriptorId);
    analysisWorkspaceStore.setActiveDescriptorView({
      descriptorId: activeDescriptorId,
      displayUnits: activeDescriptorDisplayUnits,
      range: activeDescriptorRange,
      selectedSeriesIds: effectiveDescriptorSelection,
    });
  }, [activeDescriptorDisplayUnits, activeDescriptorId, activeDescriptorRange, effectiveDescriptorSelection]);
  useEffect(() => {
    if (!selectedDatasetRef || !dataset.visibleTable || hasChartState) return;
    const xAxisId = dataset.visibleTable.columns[0]?.column_id ?? "x";
    analysisWorkspaceStore.setChartState(
      xAxisId,
      descriptor?.selectedSeriesIds ?? tableDefaultSeriesIds,
    );
  }, [dataset.visibleTable, descriptor, hasChartState, selectedDatasetRef, tableDefaultSeriesIds]);

  const setActiveSurface = useCallback((surface: typeof activeSurface) => {
    setPreferenceActiveSurface(surface);
    analysisWorkspaceStore.setActiveSurface(surface);
  }, [setPreferenceActiveSurface]);
  const onSubviewChange = useCallback(
    (subview: AnalysisSubview) => setPreferenceActiveSubview(activeSurface, subview),
    [activeSurface, setPreferenceActiveSubview],
  );
  const setSelectedDatasetRef = useCallback((nextDatasetRef: string | null) => {
    setPreferenceDatasetRef(nextDatasetRef);
    analysisWorkspaceStore.setSelectedDatasetRef(nextDatasetRef);
  }, [setPreferenceDatasetRef]);
  const onPointSelect = useCallback((point: AnalysisChartCursorPoint) => {
    setSelectedPoint(point);
    const chartId = frequencyChartId ?? sourceChartId ?? descriptorId;
    analysisWorkspaceStore.setFocusedChartId(chartId);
    if (activeSurface === "resonance-fmr" || activeSurface === "dispersion") {
      const mapped = frequencyDomainSelectionFromPoint({
        artifactRevision: frequencyArtifactRevision,
        dispersionModel: frequency.frequencyDomainDispersionModel,
        resultContext: frequencyResultContext,
        point,
        responseModel: frequency.frequencyDomainResponseModel,
        routeMode: frequency.frequencyDomainRoute.mode,
        spectrumModel: frequency.frequencyDomainSpectrumModel,
        chartId,
      });
      kernel.selection.set(mapped, "analysis-plots");
      return;
    }
    const nodeId = `analysis:charts:${point.source.tableId}:point:${point.seriesId}:${point.point.rowIndex}`;
    kernel.selection.set({
      kind: "analysis.chart-point",
      label: `${point.label} ${point.point.y} ${point.unit}`,
      nodeId,
      objectId: null,
      ref: {
        chartId,
        kind: "analysis.chart-point",
        nodeId,
        quantity: point.quantity,
        rowIndex: point.point.rowIndex,
        seriesId: point.seriesId,
        tableId: point.source.tableId,
        type: "analysis-chart-point",
        x: point.point.x,
        y: point.point.y,
      },
    }, "analysis-plots");
  }, [activeSurface, descriptorId, frequency.frequencyDomainDispersionModel, frequency.frequencyDomainResponseModel, frequency.frequencyDomainRoute.mode, frequency.frequencyDomainSpectrumModel, frequencyArtifactRevision, frequencyResultContext, frequencyChartId, kernel.selection, sourceChartId]);
  const onRangeChange = useCallback((range: ChartValueRange) => {
    const targetId = frequencyDescriptorId ?? descriptorId;
    setDescriptorPreference(targetId, completeDescriptorPreference(effectiveDescriptor, effectiveDescriptorSelection, { range: { fromSI: range.fromValue, toSI: range.toValue } }));
  }, [descriptorId, effectiveDescriptor, effectiveDescriptorSelection, frequencyDescriptorId, setDescriptorPreference]);
  const onSelectedSeriesIdsChange = useCallback((nextSelectedSeriesIds: string[]) => {
    if (frequencyDescriptorId) {
      setDescriptorPreference(frequencyDescriptorId, completeDescriptorPreference(frequencyDescriptor, effectiveSelectedSeriesIds, { selectedSeriesIds: nextSelectedSeriesIds }));
      return;
    }
    setDescriptorPreference(descriptorId, completeDescriptorPreference(descriptor, tableDefaultSeriesIds, { selectedSeriesIds: nextSelectedSeriesIds }));
    analysisWorkspaceStore.setChartState(dataset.visibleTable?.columns[0]?.column_id ?? "x", nextSelectedSeriesIds);
  }, [dataset.visibleTable, descriptor, descriptorId, effectiveSelectedSeriesIds, frequencyDescriptor, frequencyDescriptorId, setDescriptorPreference, tableDefaultSeriesIds]);
  const onDisplayUnitsChange = useCallback((patch: Record<string, string>) => {
    const targetId = frequencyDescriptorId ?? descriptorId;
    setDescriptorPreference(targetId, completeDescriptorPreference(effectiveDescriptor, effectiveDescriptorSelection, {
      displayUnits: { ...(effectiveDescriptor?.displayUnits ?? {}), ...patch },
    }));
  }, [descriptorId, effectiveDescriptor, effectiveDescriptorSelection, frequencyDescriptorId, setDescriptorPreference]);

  return {
    activeSubview,
    activeSurface,
    comparisonUnavailableReason: ANALYSIS_COMPARISON_UNAVAILABLE_REASON,
    datasetRefs,
    dynamicStructureFactor: dynamicStructureFactor.data ?? null,
    dynamicStructureFactorStatus: dynamicStructureFactor.status,
    frequencyDomainSeries: frequency.frequencyDomainSeries,
    frequencyDomainStatus: frequency.frequencyDomainStatus,
    frequencyDomainPresentation: frequency.frequencyDomainPresentation,
    frequencyDomainComparisonModel: frequency.frequencyDomainComparisonModel,
    frequencyDomainCalculationMode: frequency.frequencyDomainRoute.mode,
    frequencyDomainTitle: frequency.frequencyDomainTitle,
    frequencyDomainUnavailableReason: frequency.frequencyDomainUnavailableReason,
    frequencyDomainProvenance,
    selectedDatasetRef,
    descriptorId: activeDescriptorId,
    sourceChartId: activeSurface === "comparison" ? null : frequencyChartId ?? sourceChartId,
    selectedStageId,
    surfaceProvenance,
    selectedPoint,
    selectedSeriesIds: effectiveSelectedSeriesIds,
    displayUnits: activeDescriptorDisplayUnits,
    range: visibleRange,
    setActiveSurface,
    onSubviewChange,
    setSelectedDatasetRef,
    onPointSelect,
    onRangeChange,
    onSelectedSeriesIdsChange,
    onDisplayUnitsChange,
    spinWaveGamma: gamma.data ?? null,
    spinWaveGammaStatus: gamma.status,
    table: dataset.visibleTable,
    tableStatus: dataset.rows.status,
    tableUnsupportedReason: dataset.unsupportedReason,
    subviews,
    visibleDatasetRevision: dataset.visibleRevision,
    xAxisId,
  };
}

export function selectedHysteresisStageIdFromSelection(selection: Selection | null): string | null {
  const ref = selection?.ref as { stageId?: string; stageKind?: string; type?: string } | null;
  if (!ref?.stageId) return null;
  return (ref.type === "study-stage" && selection?.nodeId?.includes("hysteresis")) || ref.type === "hysteresis-snapshot" || ref.type === "analysis-chart-point"
    ? ref.stageId
    : null;
}

function completeDescriptorPreference(
  descriptor: AnalysisDescriptorPreference | undefined,
  defaults: readonly string[],
  patch: Partial<AnalysisDescriptorPreference>,
): AnalysisDescriptorPreference {
  return {
    displayUnits: patch.displayUnits ?? descriptor?.displayUnits ?? {},
    range: patch.range ?? descriptor?.range ?? null,
    selectedSeriesIds: patch.selectedSeriesIds ?? descriptor?.selectedSeriesIds ?? [...defaults],
  };
}

export { frequencyDomainChartRouteOverrideFromSelection } from "@/shared/domain/analysis/frequencyDomainChartModels";
export { frequencyDomainChartTitle } from "./hooks/useAnalysisFrequencyData";
/** Compatibility export while point ownership moves to the selected artifact surface. */
export function frequencyDomainSelectionFromPoint(input: {
  artifactRevision?: number | string | null;
  chartId?: string;
  dispersionModel: AnalysisFrequencyDataResult["frequencyDomainDispersionModel"];
  point: AnalysisChartCursorPoint;
  resultContext?: FrequencyDomainResultContext | null;
  responseModel: AnalysisFrequencyDataResult["frequencyDomainResponseModel"];
  routeMode: AnalysisFrequencyDataResult["frequencyDomainRoute"]["mode"];
  spectrumModel: AnalysisFrequencyDataResult["frequencyDomainSpectrumModel"];
}) {
  const point = input.point;
  const nodeId = `analysis:charts:${point.source.tableId}:point:${point.seriesId}:${point.point.rowIndex}`;
  const resultContext = input.resultContext;
  const artifactRevision = input.artifactRevision == null
    ? undefined
    : String(input.artifactRevision);
  const kContextKind = resultContext?.classification?.kContext.kind;
  const wavevectorKf = resultContext?.kSampling?.kind === "single"
    ? resultContext.kSampling.vectorRadPerM
    : undefined;
  const identity = {
    analysisRunId: resultContext?.runId ?? undefined,
    analysisStageId: resultContext?.stageId ?? undefined,
    artifactRevision,
    equilibriumId: resultContext?.equilibriumId ?? undefined,
    kContextKind,
    normalization: resultContext?.normalization ?? undefined,
    representation: "complex-vector-xyz" as const,
    studyProduct: resultContext?.studyProduct ?? undefined,
    wavevectorKf,
  };
  if (input.routeMode === "fmr_response" || input.routeMode === "frequency_response") {
    const match = input.responseModel.points.find((entry) =>
      entry.frequencyIndex === point.point.rowIndex ||
      entry.frequencyHz / 1e9 === point.point.x
    );
    return { kind: "results.frequency_response.frequency_point", label: `${point.label} ${point.point.y} ${point.unit}`, nodeId, objectId: null, ref: compactSelectionRef({ ...identity, calculationMode: input.routeMode, chartId: input.chartId, fieldId: match?.fieldId ?? undefined, frequencyHz: match?.frequencyHz, frequencyIndex: match?.frequencyIndex ?? undefined, kind: "results.frequency_response.frequency_point", nodeId, observableId: match?.observableId, resourceRef: point.source.resourceKey, source: "frequency-response" as const, type: "frequency-domain" as const }) };
  }
  const spectrumMode = input.routeMode === "dispersion_modal"
    ? null
    : input.spectrumModel.points[point.point.rowIndex];
  const mode = input.routeMode === "dispersion_modal"
    ? input.dispersionModel.points[point.point.rowIndex]
    : spectrumMode;
  return { kind: "results.eigen.mode", label: `${point.label} ${point.point.y} ${point.unit}`, nodeId, objectId: null, ref: compactSelectionRef({ ...identity, artifactPath: point.source.resourceKey, branchId: mode?.branchId ?? undefined, calculationMode: input.routeMode, chartId: input.chartId, fieldId: mode?.modeFieldId ?? undefined, frequencyHz: mode?.frequencyHz, kind: "results.eigen.mode", modeId: spectrumMode?.modeId ?? undefined, modeIndex: mode?.rawModeIndex, nodeId, resourceRef: mode?.modeFieldResourceKey ?? point.source.resourceKey, sampleId: spectrumMode?.sampleId ?? undefined, sampleIndex: mode?.sampleIndex, source: "eigen-mode" as const, type: "frequency-domain" as const }) };
}

function compactSelectionRef<T extends Record<string, unknown>>(ref: T): T {
  return Object.fromEntries(
    Object.entries(ref).filter(([, value]) => value !== undefined),
  ) as T;
}

function analysisPresentationRevision(
  presentation: ChartDataPresentationState | undefined,
): number | string | null {
  if (!presentation) return null;
  switch (presentation.kind) {
    case "ready":
      return presentation.revision;
    case "refreshing":
    case "paused":
    case "stale":
      return presentation.visibleRevision;
    case "empty":
      return presentation.revision;
    default:
      return null;
  }
}
