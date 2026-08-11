"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { useDynamicStructureFactorResource, useSpinWaveGammaResource } from "@/kernel/resources/spinWaveResources";
import { useSelectionSelector } from "@/kernel/selection/useSelection";
import type { Selection } from "@/kernel/selection/selectionTypes";
import type { KernelApi } from "@/kernel/types";
import { analysisWorkspaceStore } from "@/kernel/workspace/analysisWorkspace";
import { analysisDescriptorId, type AnalysisDescriptorPreference } from "@/kernel/workspace/analysisViewPreferences";
import { useAnalysisViewPreferencesHydration } from "@/kernel/workspace/useAnalysisViewPreferencesHydration";
import { useAnalysisWorkspaceSelector } from "@/kernel/workspace/useAnalysisWorkspace";

import { useAnalysisDatasetData } from "./hooks/useAnalysisDatasetData";
import {
  useAnalysisFrequencyData,
  type AnalysisFrequencyDataResult,
} from "./hooks/useAnalysisFrequencyData";
import type { AnalysisChartCursorPoint } from "@/shared/domain/analysis/chartCursorPoint";
import type { ChartValueRange } from "./chartTableModel";

const EMPTY_DISPLAY_UNITS: Record<string, string> = {};

export function useAnalysisPlotsController(kernel: KernelApi) {
  const activeSurface = useAnalysisWorkspaceSelector((state) => state.activeSurface);
  const selectedDatasetRef = useAnalysisWorkspaceSelector((state) => state.selectedDatasetRef);
  const sourceChartId = useAnalysisWorkspaceSelector((state) => state.sourceChartId);
  const comparisonDatasetRef = useAnalysisWorkspaceSelector((state) => state.comparisonDatasetRef);
  const comparisonSelectedSeriesKeys = useAnalysisWorkspaceSelector((state) => state.comparisonSelectedSeriesKeys);
  const hasChartState = useAnalysisWorkspaceSelector((state) => state.hasChartState);
  const hasComparisonSelection = useAnalysisWorkspaceSelector((state) => state.hasComparisonSelection);
  const selectedSeriesIds = useAnalysisWorkspaceSelector((state) => state.selectedSeriesIds);
  const xAxisId = useAnalysisWorkspaceSelector((state) => state.xAxisId);
  const preferences = useAnalysisViewPreferencesHydration();
  const applied = useRef(false);
  useEffect(() => {
    if (!preferences.isHydrated || applied.current) return;
    applied.current = true;
    analysisWorkspaceStore.setActiveSurface(preferences.preferences.activeSurface);
    analysisWorkspaceStore.setSelectedDatasetRef(preferences.preferences.selectedDatasetRef);
  }, [preferences.isHydrated, preferences.preferences.activeSurface, preferences.preferences.selectedDatasetRef]);

  const dataset = useAnalysisDatasetData({ datasetRef: selectedDatasetRef, enabled: activeSurface === "dynamics" || activeSurface === "comparison" });
  const comparisonDataset = useAnalysisDatasetData({ datasetRef: comparisonDatasetRef, enabled: activeSurface === "comparison" && comparisonDatasetRef !== null });
  useEffect(() => { analysisWorkspaceStore.setVisibleDatasetRevision(dataset.visibleRevision); }, [dataset.visibleRevision]);
  const comparisonXAxisId = comparisonDataset.visibleTable?.columns[0]?.column_id ?? null;
  useEffect(() => {
    analysisWorkspaceStore.setComparisonXAxisId(comparisonXAxisId);
  }, [comparisonXAxisId]);
  const frequency = useAnalysisFrequencyData(activeSurface === "frequency-response" || activeSurface === "eigenmodes" ? activeSurface : "idle");
  const frequencyChartId = (activeSurface === "frequency-response" || activeSurface === "eigenmodes") && frequency.frequencyDomainSeries[0]
    ? `${activeSurface}:${frequency.frequencyDomainSeries[0].source.resourceKey}`
    : null;
  useEffect(() => {
    if (activeSurface === "frequency-response" || activeSurface === "eigenmodes") {
      analysisWorkspaceStore.setFocusedChartId(frequencyChartId);
      return;
    }
    analysisWorkspaceStore.setFocusedChartId(sourceChartId);
  }, [activeSurface, frequencyChartId, sourceChartId]);
  const gamma = useSpinWaveGammaResource(activeSurface === "spectrum");
  const dynamicStructureFactor = useDynamicStructureFactorResource(activeSurface === "dispersion");
  const selectedStageId = useSelectionSelector(selectedHysteresisStageIdFromSelection);
  const [selectedPoint, setSelectedPoint] = useState<AnalysisChartCursorPoint | null>(null);
  const descriptorId = useMemo(
    () => analysisDescriptorId({ kind: "dataset", surface: activeSurface, datasetRef: selectedDatasetRef }),
    [activeSurface, selectedDatasetRef],
  );
  const descriptor = preferences.preferences.descriptorPreferences[descriptorId];
  const frequencyDescriptorId = frequencyChartId
    ? analysisDescriptorId({ kind: "artifact", surface: activeSurface === "eigenmodes" ? "eigenmodes" : "frequency-response", resourceKey: frequency.frequencyDomainSeries[0]!.source.resourceKey })
    : null;
  const frequencyDescriptor = frequencyDescriptorId
    ? preferences.preferences.descriptorPreferences[frequencyDescriptorId]
    : undefined;
  const tableDefaultSeriesIds = dataset.visibleTable
    ? dataset.visibleTable.columns.slice(1).map((column) => `data.table:${dataset.visibleTable!.tableId}:${dataset.visibleTable!.columns[0]?.column_id ?? "x"}:${column.column_id}`)
    : selectedSeriesIds;
  const effectiveSelectedSeriesIds = frequencyChartId
    ? frequencyDescriptor?.selectedSeriesIds ?? frequency.frequencyDomainSeries.map((series) => series.id)
    : selectedSeriesIds;
  const comparisonDescriptorId = useMemo(
    () => analysisDescriptorId({ kind: "comparison", primaryDatasetRef: selectedDatasetRef, secondaryDatasetRef: comparisonDatasetRef }),
    [comparisonDatasetRef, selectedDatasetRef],
  );
  const comparisonDescriptor = preferences.preferences.descriptorPreferences[comparisonDescriptorId];
  const comparisonDefaultSeriesIds = useMemo(() => {
    if (!comparisonDataset.visibleTable || !dataset.visibleTable) return [];
    const secondary = new Set(comparisonDataset.visibleTable.columns.slice(1).map((column) => `${encodeURIComponent(column.column_id)}|${encodeURIComponent(column.unit)}`));
    return dataset.visibleTable.columns.slice(1)
      .map((column) => `${encodeURIComponent(column.column_id)}|${encodeURIComponent(column.unit)}`)
      .filter((key) => secondary.has(key));
  }, [comparisonDataset.visibleTable, dataset.visibleTable]);
  const comparisonAxesCompatible = dataset.visibleTable?.columns[0]?.column_id === comparisonDataset.visibleTable?.columns[0]?.column_id &&
    dataset.visibleTable?.columns[0]?.unit === comparisonDataset.visibleTable?.columns[0]?.unit;
  const effectiveDescriptor = frequencyDescriptorId
    ? frequencyDescriptor
    : activeSurface === "comparison"
      ? comparisonDescriptor
      : descriptor;
  const effectiveDescriptorSelection = frequencyDescriptorId
    ? effectiveSelectedSeriesIds
    : activeSurface === "comparison"
      ? comparisonDescriptor?.selectedSeriesIds ?? comparisonDefaultSeriesIds
      : descriptor?.selectedSeriesIds ?? tableDefaultSeriesIds;
  const activeDescriptorId = frequencyDescriptorId ?? (activeSurface === "comparison" ? comparisonDescriptorId : descriptorId);
  const activeDescriptorDisplayUnits = effectiveDescriptor?.displayUnits ?? EMPTY_DISPLAY_UNITS;
  const activeDescriptorRange = activeSurface === "comparison" && !comparisonAxesCompatible
    ? null
    : effectiveDescriptor?.range ?? null;
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
  useEffect(() => {
    if (!comparisonDataset.visibleTable || !dataset.visibleTable || hasComparisonSelection) return;
    analysisWorkspaceStore.setComparisonSelection(
      comparisonDescriptor?.selectedSeriesIds ?? comparisonDefaultSeriesIds,
    );
  }, [comparisonDataset.visibleTable, comparisonDefaultSeriesIds, comparisonDescriptor?.selectedSeriesIds, dataset.visibleTable, hasComparisonSelection]);
  return {
    activeSurface,
    datasetRefs: dataset.tableList.data?.tables.map((table) => table.table_id) ?? [],
    dynamicStructureFactor: dynamicStructureFactor.data ?? null,
    dynamicStructureFactorStatus: dynamicStructureFactor.status,
    frequencyDomainSeries: frequency.frequencyDomainSeries,
    frequencyDomainStatus: frequency.frequencyDomainStatus,
    frequencyDomainPresentation: frequency.frequencyDomainPresentation,
    frequencyDomainTitle: frequency.frequencyDomainTitle,
    frequencyDomainUnavailableReason: frequency.frequencyDomainUnavailableReason,
    frequencyDomainProvenance: frequency.frequencyDomainSeries[0] ? `${frequency.frequencyDomainSeries[0].source.resourceKey} · revision ${frequency.frequencyDomainSeries[0].dataRevision}` : null,
    selectedDatasetRef,
    descriptorId: activeDescriptorId,
    sourceChartId: frequencyChartId ?? sourceChartId,
    comparisonDatasetRef,
    comparisonSelectedSeriesKeys,
    comparisonTable: comparisonDataset.visibleTable,
    comparisonTableStatus: comparisonDataset.rows.status,
    comparisonTableUnsupportedReason: comparisonDataset.unsupportedReason,
    comparisonVisibleRevision: comparisonDataset.visibleRevision,
    comparisonPrimaryDisplayUnits: comparisonDescriptor?.displayUnits ?? {},
    comparisonSecondaryDisplayUnits: comparisonDescriptor?.displayUnits ?? {},
    hasComparisonSelection,
    selectedStageId,
    surfaceProvenance: {
      dispersion: dynamicStructureFactor.data ? `${dynamicStructureFactor.data.artifact_ref} · revision ${dynamicStructureFactor.data.schema_version}` : undefined,
      hysteresis: selectedStageId ? `hysteresis · ${selectedStageId}` : undefined,
      spectrum: gamma.data ? `spin-wave-gamma · revision ${gamma.data.schema_version}` : undefined,
    },
    selectedPoint,
    selectedSeriesIds: effectiveSelectedSeriesIds,
    displayUnits: effectiveDescriptor?.displayUnits ?? {},
    range: comparisonAxesCompatible || activeSurface !== "comparison"
      ? effectiveDescriptor?.range ? { fromValue: effectiveDescriptor.range.fromSI, toValue: effectiveDescriptor.range.toSI } : null
      : null,
    setActiveSurface: (surface: typeof activeSurface) => {
      preferences.setActiveSurface(surface);
      analysisWorkspaceStore.setActiveSurface(surface);
    },
    setSelectedDatasetRef: (datasetRef: string | null) => {
      preferences.setSelectedDatasetRef(datasetRef);
      analysisWorkspaceStore.setSelectedDatasetRef(datasetRef);
    },
    setComparisonDatasetRef: (datasetRef: string | null) => analysisWorkspaceStore.setComparisonDatasetRef(datasetRef),
    onComparisonSelectedSeriesKeysChange: (seriesKeys: string[]) => {
      analysisWorkspaceStore.setComparisonSelection(seriesKeys);
      preferences.setDescriptorPreference(comparisonDescriptorId, completeDescriptorPreference(comparisonDescriptor, comparisonDefaultSeriesIds, { selectedSeriesIds: seriesKeys }));
    },
    onComparisonPrimaryDisplayUnitsChange: (patch: Record<string, string>) => preferences.setDescriptorPreference(comparisonDescriptorId, completeDescriptorPreference(comparisonDescriptor, comparisonDefaultSeriesIds, {
      displayUnits: { ...(comparisonDescriptor?.displayUnits ?? {}), ...patch },
    })),
    onComparisonSecondaryDisplayUnitsChange: (patch: Record<string, string>) => preferences.setDescriptorPreference(comparisonDescriptorId, completeDescriptorPreference(comparisonDescriptor, comparisonDefaultSeriesIds, {
      displayUnits: { ...(comparisonDescriptor?.displayUnits ?? {}), ...patch },
    })),
    onPointSelect: (point: AnalysisChartCursorPoint) => {
      setSelectedPoint(point);
      const chartId = activeSurface === "comparison" && point.source.tableId === comparisonDatasetRef
        ? `comparison:${comparisonDatasetRef}`
        : frequencyChartId ?? sourceChartId ?? descriptorId;
      analysisWorkspaceStore.setFocusedChartId(chartId);
      if (activeSurface === "frequency-response" || activeSurface === "eigenmodes") {
        const mapped = frequencyDomainSelectionFromPoint({
          dispersionModel: frequency.frequencyDomainDispersionModel,
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
    },
    onRangeChange: (range: ChartValueRange) => {
      if (activeSurface === "comparison" && !comparisonAxesCompatible) return;
      const targetId = frequencyDescriptorId ?? (activeSurface === "comparison" ? comparisonDescriptorId : descriptorId);
      preferences.setDescriptorPreference(targetId, completeDescriptorPreference(effectiveDescriptor, effectiveDescriptorSelection, { range: { fromSI: range.fromValue, toSI: range.toValue } }));
    },
    onSelectedSeriesIdsChange: (nextSelectedSeriesIds: string[]) => {
      if (frequencyDescriptorId) {
        preferences.setDescriptorPreference(frequencyDescriptorId, completeDescriptorPreference(frequencyDescriptor, effectiveSelectedSeriesIds, { selectedSeriesIds: nextSelectedSeriesIds }));
        return;
      }
      preferences.setDescriptorPreference(descriptorId, completeDescriptorPreference(descriptor, tableDefaultSeriesIds, { selectedSeriesIds: nextSelectedSeriesIds }));
      analysisWorkspaceStore.setChartState(dataset.visibleTable?.columns[0]?.column_id ?? "x", nextSelectedSeriesIds);
    },
    onDisplayUnitsChange: (patch: Record<string, string>) => {
      const targetId = frequencyDescriptorId ?? (activeSurface === "comparison" ? comparisonDescriptorId : descriptorId);
      preferences.setDescriptorPreference(targetId, completeDescriptorPreference(effectiveDescriptor, effectiveDescriptorSelection, {
        displayUnits: { ...(effectiveDescriptor?.displayUnits ?? {}), ...patch },
      }));
    },
    spinWaveGamma: gamma.data ?? null,
    spinWaveGammaStatus: gamma.status,
    table: dataset.visibleTable,
    tableStatus: dataset.rows.status,
    tableUnsupportedReason: dataset.unsupportedReason,
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
  chartId?: string;
  dispersionModel: AnalysisFrequencyDataResult["frequencyDomainDispersionModel"];
  point: AnalysisChartCursorPoint;
  responseModel: AnalysisFrequencyDataResult["frequencyDomainResponseModel"];
  routeMode: AnalysisFrequencyDataResult["frequencyDomainRoute"]["mode"];
  spectrumModel: AnalysisFrequencyDataResult["frequencyDomainSpectrumModel"];
}) {
  const point = input.point;
  const nodeId = `analysis:charts:${point.source.tableId}:point:${point.seriesId}:${point.point.rowIndex}`;
  if (input.routeMode === "fmr_response") {
    const match = input.responseModel.points.find((entry) =>
      entry.frequencyIndex === point.point.rowIndex ||
      entry.frequencyHz / 1e9 === point.point.x
    );
    return { kind: "results.frequency_response.frequency_point", label: `${point.label} ${point.point.y} ${point.unit}`, nodeId, objectId: null, ref: { calculationMode: input.routeMode, chartId: input.chartId, fieldId: match?.fieldId ?? undefined, frequencyIndex: match?.frequencyIndex ?? undefined, kind: "results.frequency_response.frequency_point", nodeId, observableId: match?.observableId, resourceRef: point.source.resourceKey, type: "frequency-domain" as const } };
  }
  const mode = input.routeMode === "dispersion_modal"
    ? input.dispersionModel.points[point.point.rowIndex]
    : input.spectrumModel.points[point.point.rowIndex];
  return { kind: "results.eigen.mode", label: `${point.label} ${point.point.y} ${point.unit}`, nodeId, objectId: null, ref: { artifactPath: point.source.resourceKey, branchId: mode?.branchId ?? undefined, calculationMode: input.routeMode, chartId: input.chartId, fieldId: mode?.modeFieldId ?? undefined, kind: "results.eigen.mode", modeIndex: mode?.rawModeIndex, nodeId, resourceRef: mode?.modeFieldResourceKey ?? point.source.resourceKey, sampleIndex: mode?.sampleIndex, type: "frequency-domain" as const } };
}
