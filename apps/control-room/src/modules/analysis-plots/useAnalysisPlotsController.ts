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
  const comparisonDatasetRef = useAnalysisWorkspaceSelector((state) => state.comparisonDatasetRef);
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
    comparisonDatasetRef,
    comparisonTable: comparisonDataset.visibleTable,
    comparisonTableStatus: comparisonDataset.rows.status,
    comparisonVisibleRevision: comparisonDataset.visibleRevision,
    selectedStageId,
    surfaceProvenance: {
      dispersion: dynamicStructureFactor.data ? "dynamic-structure-factor" : undefined,
      hysteresis: selectedStageId ? `hysteresis · ${selectedStageId}` : undefined,
      spectrum: gamma.data ? "spin-wave-gamma" : undefined,
    },
    selectedPoint,
    selectedSeriesIds: descriptor?.selectedSeriesIds ?? [],
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
    onPointSelect: (point: AnalysisChartCursorPoint) => {
      setSelectedPoint(point);
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
    onSelectedSeriesIdsChange: (selectedSeriesIds: string[]) => preferences.setDescriptorPreference(descriptorId, { selectedSeriesIds }),
    spinWaveGamma: gamma.data ?? null,
    spinWaveGammaStatus: gamma.status,
    table: dataset.visibleTable,
    tableStatus: dataset.rows.status,
    tableUnsupportedReason: dataset.unsupportedReason,
    visibleDatasetRevision: dataset.visibleRevision,
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
