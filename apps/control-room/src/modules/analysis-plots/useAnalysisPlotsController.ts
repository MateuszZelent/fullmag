"use client";

import { useEffect, useRef } from "react";

import { useDynamicStructureFactorResource, useSpinWaveGammaResource } from "@/kernel/resources/spinWaveResources";
import { useSelectionSelector } from "@/kernel/selection/useSelection";
import type { Selection } from "@/kernel/selection/selectionTypes";
import type { KernelApi } from "@/kernel/types";
import { analysisWorkspaceStore } from "@/kernel/workspace/analysisWorkspace";
import { useAnalysisViewPreferencesHydration } from "@/kernel/workspace/useAnalysisViewPreferencesHydration";
import { useAnalysisWorkspaceSelector } from "@/kernel/workspace/useAnalysisWorkspace";

import { useAnalysisDatasetData } from "./hooks/useAnalysisDatasetData";
import { useAnalysisFrequencyData } from "./hooks/useAnalysisFrequencyData";

export function useAnalysisPlotsController(_kernel: KernelApi) {
  const activeSurface = useAnalysisWorkspaceSelector((state) => state.activeSurface);
  const selectedDatasetRef = useAnalysisWorkspaceSelector((state) => state.selectedDatasetRef);
  const preferences = useAnalysisViewPreferencesHydration();
  const applied = useRef(false);
  useEffect(() => {
    if (!preferences.isHydrated || applied.current) return;
    applied.current = true;
    analysisWorkspaceStore.setActiveSurface(preferences.preferences.activeSurface);
    analysisWorkspaceStore.setSelectedDatasetRef(preferences.preferences.selectedDatasetRef);
  }, [preferences.isHydrated, preferences.preferences.activeSurface, preferences.preferences.selectedDatasetRef]);

  const dataset = useAnalysisDatasetData({ datasetRef: selectedDatasetRef, enabled: activeSurface === "dynamics" });
  const frequency = useAnalysisFrequencyData(activeSurface === "frequency-response" || activeSurface === "eigenmodes" ? "frequency" : "idle");
  const gamma = useSpinWaveGammaResource(activeSurface === "spectrum");
  const dynamicStructureFactor = useDynamicStructureFactorResource(activeSurface === "dispersion");
  const selectedStageId = useSelectionSelector(selectedHysteresisStageIdFromSelection);
  return {
    activeSurface,
    datasetRefs: dataset.tableList.data?.tables.map((table) => table.table_id) ?? [],
    dynamicStructureFactor: dynamicStructureFactor.data ?? null,
    dynamicStructureFactorStatus: dynamicStructureFactor.status,
    frequencyDomainSeries: frequency.frequencyDomainSeries,
    frequencyDomainStatus: frequency.frequencyDomainStatus,
    frequencyDomainTitle: frequency.frequencyDomainTitle,
    frequencyDomainUnavailableReason: frequency.frequencyDomainUnavailableReason,
    selectedDatasetRef,
    selectedStageId,
    setActiveSurface: (surface: typeof activeSurface) => {
      preferences.setActiveSurface(surface);
      analysisWorkspaceStore.setActiveSurface(surface);
    },
    setSelectedDatasetRef: (datasetRef: string | null) => {
      preferences.setSelectedDatasetRef(datasetRef);
      analysisWorkspaceStore.setSelectedDatasetRef(datasetRef);
    },
    spinWaveGamma: gamma.data ?? null,
    spinWaveGammaStatus: gamma.status,
    table: dataset.visibleTable,
    tableStatus: dataset.rows.status,
    tableUnsupportedReason: dataset.unsupportedReason,
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
    const match = input.responseModel?.points?.find((entry: any) => entry.frequencyIndex === point.point.rowIndex || entry.frequencyGHz === point.point.x);
    return { kind: "results.frequency_response.frequency_point", label: `${point.label} ${point.point.y} ${point.unit}`, nodeId, objectId: null, ref: { calculationMode: input.routeMode, fieldId: match?.fieldId, frequencyIndex: match?.frequencyIndex, kind: "results.frequency_response.frequency_point", nodeId, observableId: match?.observableId, resourceRef: point.source.resourceKey, type: "frequency-domain" } };
  }
  const mode = input.routeMode === "dispersion_modal" ? input.dispersionModel?.points?.[point.point.rowIndex] : input.spectrumModel?.modes?.[point.point.rowIndex];
  return { kind: "results.eigen.mode", label: `${point.label} ${point.point.y} ${point.unit}`, nodeId, objectId: null, ref: { branchId: mode?.branchId, calculationMode: input.routeMode, fieldId: mode?.fieldId ?? mode?.modeFieldId, kind: "results.eigen.mode", modeIndex: mode?.rawModeIndex, nodeId, resourceRef: mode?.resourceRef ?? point.source.resourceKey, sampleIndex: mode?.sampleIndex, type: "frequency-domain" } };
}
