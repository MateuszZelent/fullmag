"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { useDynamicStructureFactorResource, useSpinWaveGammaResource } from "@/kernel/resources/spinWaveResources";
import { useSelectionSelector } from "@/kernel/selection/useSelection";
import type { Selection } from "@/kernel/selection/selectionTypes";
import type { KernelApi } from "@/kernel/types";
import { analysisWorkspaceStore } from "@/kernel/workspace/analysisWorkspace";
import { useAnalysisViewPreferencesHydration } from "@/kernel/workspace/useAnalysisViewPreferencesHydration";
import { useAnalysisWorkspaceSelector } from "@/kernel/workspace/useAnalysisWorkspace";

import { useAnalysisDatasetData } from "./hooks/useAnalysisDatasetData";
import { useAnalysisFrequencyData } from "./hooks/useAnalysisFrequencyData";
import type { AnalysisChartCursorPoint } from "@/shared/domain/analysis/chartCursorPoint";
import type { ChartValueRange } from "./chartTableModel";

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
  const frequency = useAnalysisFrequencyData(activeSurface === "frequency-response" || activeSurface === "eigenmodes" ? activeSurface : "idle");
  const gamma = useSpinWaveGammaResource(activeSurface === "spectrum");
  const dynamicStructureFactor = useDynamicStructureFactorResource(activeSurface === "dispersion");
  const selectedStageId = useSelectionSelector(selectedHysteresisStageIdFromSelection);
  const [selectedPoint, setSelectedPoint] = useState<AnalysisChartCursorPoint | null>(null);
  const descriptorId = useMemo(
    () => `${activeSurface}:${selectedDatasetRef ?? "none"}`,
    [activeSurface, selectedDatasetRef],
  );
  const descriptor = preferences.preferences.descriptorPreferences[descriptorId];
  const comparisonDescriptorId = useMemo(
    () => `comparison:${selectedDatasetRef ?? "none"}:${comparisonDatasetRef ?? "none"}`,
    [comparisonDatasetRef, selectedDatasetRef],
  );
  const comparisonDescriptor = preferences.preferences.descriptorPreferences[comparisonDescriptorId];
  useEffect(() => {
    if (!selectedDatasetRef || !dataset.visibleTable || hasChartState) return;
    const xAxisId = dataset.visibleTable.columns[0]?.column_id ?? "x";
    const defaultSeriesIds = dataset.visibleTable.columns.slice(1).map(
      (column) => `data.table:${dataset.visibleTable!.tableId}:${xAxisId}:${column.column_id}`,
    );
    analysisWorkspaceStore.setChartState(
      xAxisId,
      descriptor ? descriptor.selectedSeriesIds : defaultSeriesIds,
    );
  }, [dataset.visibleTable, descriptor, hasChartState, selectedDatasetRef]);
  useEffect(() => {
    if (!comparisonDataset.visibleTable || !dataset.visibleTable || hasComparisonSelection) return;
    const secondary = new Set(
      comparisonDataset.visibleTable.columns.slice(1).map((column) => `${encodeURIComponent(column.column_id)}|${encodeURIComponent(column.unit)}`),
    );
    const defaults = dataset.visibleTable.columns.slice(1)
      .map((column) => `${encodeURIComponent(column.column_id)}|${encodeURIComponent(column.unit)}`)
      .filter((key) => secondary.has(key));
    analysisWorkspaceStore.setComparisonSelection(
      comparisonDescriptor?.comparisonSelectedSeriesKeys ?? defaults,
    );
  }, [comparisonDataset.visibleTable, comparisonDescriptor?.comparisonSelectedSeriesKeys, dataset.visibleTable, hasComparisonSelection]);
  return {
    activeSurface,
    datasetRefs: dataset.tableList.data?.tables.map((table) => table.table_id) ?? [],
    dynamicStructureFactor: dynamicStructureFactor.data ?? null,
    dynamicStructureFactorStatus: dynamicStructureFactor.status,
    frequencyDomainSeries: frequency.frequencyDomainSeries,
    frequencyDomainStatus: frequency.frequencyDomainStatus,
    frequencyDomainTitle: frequency.frequencyDomainTitle,
    frequencyDomainUnavailableReason: frequency.frequencyDomainUnavailableReason,
    frequencyDomainProvenance: frequency.frequencyDomainSeries[0] ? `${frequency.frequencyDomainSeries[0].source.resourceKey} · revision ${frequency.frequencyDomainSeries[0].dataRevision}` : null,
    selectedDatasetRef,
    sourceChartId,
    comparisonDatasetRef,
    comparisonSelectedSeriesKeys,
    comparisonTable: comparisonDataset.visibleTable,
    comparisonTableStatus: comparisonDataset.rows.status,
    comparisonVisibleRevision: comparisonDataset.visibleRevision,
    hasComparisonSelection,
    selectedStageId,
    surfaceProvenance: {
      dispersion: dynamicStructureFactor.data ? `${dynamicStructureFactor.data.artifact_ref} · revision ${dynamicStructureFactor.data.schema_version}` : undefined,
      hysteresis: selectedStageId ? `hysteresis · ${selectedStageId}` : undefined,
      spectrum: gamma.data ? `spin-wave-gamma · revision ${gamma.data.schema_version}` : undefined,
    },
    selectedPoint,
    selectedSeriesIds,
    range: descriptor?.range ? { fromValue: descriptor.range.fromSI, toValue: descriptor.range.toSI } : null,
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
      preferences.setDescriptorPreference(comparisonDescriptorId, { comparisonSelectedSeriesKeys: seriesKeys });
    },
    onPointSelect: (point: AnalysisChartCursorPoint) => {
      setSelectedPoint(point);
      if (activeSurface === "frequency-response" || activeSurface === "eigenmodes") {
        const mapped = frequencyDomainSelectionFromPoint({
          dispersionModel: frequency.frequencyDomainDispersionModel,
          point,
          responseModel: frequency.frequencyDomainResponseModel,
          routeMode: frequency.frequencyDomainRoute.mode,
          spectrumModel: frequency.frequencyDomainSpectrumModel,
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
          chartId: descriptorId,
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
    onRangeChange: (range: ChartValueRange) => preferences.setDescriptorPreference(descriptorId, { range: { fromSI: range.fromValue, toSI: range.toValue } }),
    onSelectedSeriesIdsChange: (nextSelectedSeriesIds: string[]) => { preferences.setDescriptorPreference(descriptorId, { selectedSeriesIds: nextSelectedSeriesIds }); analysisWorkspaceStore.setChartState(dataset.visibleTable?.columns[0]?.column_id ?? "x", nextSelectedSeriesIds); },
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

export { frequencyDomainChartRouteOverrideFromSelection } from "@/shared/domain/analysis/frequencyDomainChartModels";
export { frequencyDomainChartTitle } from "./hooks/useAnalysisFrequencyData";
/** Compatibility export while point ownership moves to the selected artifact surface. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function frequencyDomainSelectionFromPoint(input: any): any {
  const point = input.point;
  const nodeId = `analysis:charts:${point.source.tableId}:point:${point.seriesId}:${point.point.rowIndex}`;
  if (input.routeMode === "fmr_response") {
    const match = input.responseModel?.points?.find((entry: any) => entry.frequencyIndex === point.point.rowIndex || entry.frequency_index === point.point.rowIndex || entry.frequencyHz / 1e9 === point.point.x || entry.frequencyGHz === point.point.x);
    return { kind: "results.frequency_response.frequency_point", label: `${point.label} ${point.point.y} ${point.unit}`, nodeId, objectId: null, ref: { calculationMode: input.routeMode, fieldId: match?.fieldId ?? match?.field_resource_id, frequencyIndex: match?.frequencyIndex ?? match?.frequency_index, kind: "results.frequency_response.frequency_point", nodeId, observableId: match?.observableId ?? match?.observable_id, resourceRef: point.source.resourceKey, type: "frequency-domain" } };
  }
  const mode = input.routeMode === "dispersion_modal" ? input.dispersionModel?.points?.[point.point.rowIndex] : input.spectrumModel?.points?.[point.point.rowIndex];
  return { kind: "results.eigen.mode", label: `${point.label} ${point.point.y} ${point.unit}`, nodeId, objectId: null, ref: { artifactPath: point.source.resourceKey, branchId: mode?.branchId ?? mode?.branch_id, calculationMode: input.routeMode, fieldId: mode?.fieldId ?? mode?.modeFieldId ?? mode?.mode_field_id, kind: "results.eigen.mode", modeIndex: mode?.rawModeIndex ?? mode?.raw_mode_index, nodeId, resourceRef: mode?.resourceRef ?? mode?.modeFieldResourceKey ?? mode?.mode_field_resource_key ?? point.source.resourceKey, sampleIndex: mode?.sampleIndex ?? mode?.sample_index, type: "frequency-domain" } };
}
