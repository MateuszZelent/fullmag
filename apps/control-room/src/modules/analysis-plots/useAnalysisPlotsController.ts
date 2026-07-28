"use client";

import { useEffect, useRef } from "react";

import type { KernelApi } from "@/kernel/types";
import {
  analysisPlotsWorkspaceStore,
  type AnalysisChartRangeMode,
  type AnalysisWorkbenchSurface,
  type ChartLiveMode,
} from "@/kernel/workspace/analysisPlotsWorkspace";
import { useAnalysisPlotsWorkspaceSelector } from "@/kernel/workspace/useAnalysisPlotsWorkspace";
import { useAnalysisChartPreferencesHydration } from "@/kernel/workspace/useAnalysisChartPreferencesHydration";
import { useSelectionSelector } from "@/kernel/selection/useSelection";
import type { Selection } from "@/kernel/selection/selectionTypes";

import type { ChartValueRange } from "./chartTableModel";
import type { ChartSeries } from "./chartTableModel";
import {
  analysisPlotsRangeSelectedEvent,
  analysisPlotsSeriesSelectedEvent,
  formatAnalysisPointValue,
  normalizeTableRangeModeForXAxis,
} from "./analysisPlotsModel";
import {
  recordChartRangeSelectedEvent,
  recordChartSeriesSelectedEvent,
} from "./components/chartDiagnostics";
import {
  buildEigenDispersionPointSelectionRef,
  buildEigenModeSelectionRef,
  buildEigenSpectrumChartModel,
  buildEigenDispersionChartModel,
  buildFrequencyResponsePointSelectionRef,
  buildFrequencyResponseChartModel,
  routeFrequencyDomainCalculationMode,
} from "@/shared/domain/analysis/frequencyDomainChartModels";
import type { AnalysisChartCursorPoint } from "@/shared/domain/analysis/chartCursorPoint";

import {
  tableRowsStatusForDisplay,
  useAnalysisTableData,
} from "./hooks/useAnalysisTableData";
import { useAnalysisEnergyData } from "./hooks/useAnalysisEnergyData";
import { useAnalysisFrequencyData } from "./hooks/useAnalysisFrequencyData";

export function useAnalysisPlotsController(kernel: KernelApi) {
  const { bus, selection } = kernel;
  const { activeSurface, range, rangeMode, targetPoints, liveMode, hiddenSeriesIds } =
    useAnalysisPlotsWorkspaceSelector((state) => state);
  const selectedPoint = useAnalysisPlotsWorkspaceSelector(
    (state) => state.selectedPoint,
  );

  // Wire preferences hydration (Etap 3)
  const descriptorId = analysisChartDescriptorId(activeSurface);
  const preferences = useAnalysisChartPreferencesHydration(descriptorId);
  const appliedActiveSurfaceRef = useRef(false);
  const appliedDescriptorRef = useRef<unknown>(null);

  useEffect(() => {
    if (!preferences.isHydrated) return;
    if (!appliedActiveSurfaceRef.current) {
      appliedActiveSurfaceRef.current = true;
      analysisPlotsWorkspaceStore.setActiveSurface(preferences.prefs.activeSurface);
    }
    const descriptor = preferences.descriptor;
    if (!descriptor || appliedDescriptorRef.current === descriptor) return;
    appliedDescriptorRef.current = descriptor;
    analysisPlotsWorkspaceStore.setLiveMode(descriptor.liveMode);
    analysisPlotsWorkspaceStore.setHiddenSeriesIds(descriptor.hiddenSeriesIds);
    analysisPlotsWorkspaceStore.setAxes(descriptor.xAxisId, descriptor.yAxisIds);
    analysisPlotsWorkspaceStore.setTargetPoints(descriptor.targetPoints);
    if (descriptor.range.mode === "fixed") {
      analysisPlotsWorkspaceStore.setRange({
        fromValue: descriptor.range.fromSI,
        toValue: descriptor.range.toSI,
      });
    } else {
      analysisPlotsWorkspaceStore.setRangeMode(descriptor.range);
    }
  }, [preferences.descriptor, preferences.isHydrated, preferences.prefs.activeSurface]);

  // Delegate data family loading to dedicated resource hooks (Etap 10)
  const tableData = useAnalysisTableData(kernel, {
    activeSurface,
    liveMode,
    range,
    rangeMode,
    targetPoints,
  });

  useEffect(() => {
    const normalized = normalizeTableRangeModeForXAxis(
      rangeMode,
      tableData.xAxisId,
    );
    if (normalized === rangeMode) return;
    preferences.setDescriptorRange(descriptorId, { mode: "follow" });
    analysisPlotsWorkspaceStore.setRangeMode(normalized);
  }, [descriptorId, preferences.setDescriptorRange, rangeMode, tableData.xAxisId]);

  const energyData = useAnalysisEnergyData(activeSurface);

  const frequencyData = useAnalysisFrequencyData(activeSurface);

  const selectedStageId = useSelectionSelector(
    selectedHysteresisStageIdFromSelection,
  );

  // Side-effect: sync initial analysis.chart selection
  useEffect(() => {
    const currentSelection = selection.get();
    if (selectedHysteresisStageIdFromSelection(currentSelection)) return;
    selection.set(
      {
        kind: "analysis.chart",
        label: "Table charts",
        nodeId: "analysis:charts:default",
        objectId: null,
        ref: {
          chartId: "default",
          kind: "analysis.chart",
          nodeId: "analysis:charts:default",
          tableId: "default",
          type: "analysis-chart",
        },
      },
      "analysis-plots",
    );
  }, [selection]);

  const selectPoint = (point: AnalysisChartCursorPoint) => {
    analysisPlotsWorkspaceStore.setSelectedPoint(point);
    const frequencyDomainSelection = frequencyDomainSelectionFromPoint({
      dispersionModel: frequencyData.frequencyDomainDispersionModel,
      point,
      responseModel: frequencyData.frequencyDomainResponseModel,
      routeMode: frequencyData.frequencyDomainRoute.mode,
      spectrumModel: frequencyData.frequencyDomainSpectrumModel,
    });
    if (frequencyDomainSelection) {
      selection.set(frequencyDomainSelection, "analysis-plots");
      return;
    }
    selection.set(
      {
        kind: "analysis.chart",
        label: `${point.label} ${formatAnalysisPointValue(point.point.y, point.unit)}`,
        nodeId: analysisChartPointNodeId(point),
        objectId: null,
        ref: {
          chartId: point.source.tableId,
          kind: "analysis.chart-point",
          nodeId: analysisChartPointNodeId(point),
          quantity: point.quantity,
          rowIndex: point.point.rowIndex,
          seriesId: point.seriesId,
          tableId: point.source.tableId,
          type: "analysis-chart-point",
          x: point.point.x,
          y: point.point.y,
        },
      },
      "analysis-plots",
    );
  };

  const selectSeries = (series: ChartSeries) => {
    const event = analysisPlotsSeriesSelectedEvent(series);
    bus.emit("analysis-plots:series-selected", {
      ...event,
      source: "analysis-plots",
    });
    recordChartSeriesSelectedEvent(event);
  };

  const setRange = (nextRange: ChartValueRange) => {
    preferences.setDescriptorRange(descriptorId, {
      fromSI: nextRange.fromValue,
      mode: "fixed",
      toSI: nextRange.toValue,
    });
    analysisPlotsWorkspaceStore.setRange(nextRange);
    emitRangeSelected(bus, nextRange, tableData.xAxisId);
  };

  const clearRange = () => {
    preferences.setDescriptorRange(descriptorId, { mode: "follow" });
    analysisPlotsWorkspaceStore.clearRange();
    emitRangeSelected(bus, null, tableData.xAxisId);
  };

  return {
    activeSurface,
    clearRange,
    hiddenSeriesIds,
    liveMode,
    range,
    rangeMode,
    targetPoints,
    selectedPoint,
    selectPoint,
    selectSeries,
    setRange,
    frequencyDomainSeries: frequencyData.frequencyDomainSeries,
    frequencyDomainStatus: frequencyData.frequencyDomainStatus,
    frequencyDomainTitle: frequencyData.frequencyDomainTitle,
    frequencyDomainUnavailableReason: frequencyData.frequencyDomainUnavailableReason,
    setActiveSurface: (surface: AnalysisWorkbenchSurface) => {
      preferences.setActiveSurface(surface);
      analysisPlotsWorkspaceStore.setActiveSurface(surface);
    },
    setLiveMode: (mode: ChartLiveMode) => {
      preferences.setDescriptorLiveMode(descriptorId, mode);
      analysisPlotsWorkspaceStore.setLiveMode(mode);
    },
    setRangeMode: (mode: AnalysisChartRangeMode) => {
      if (mode.mode === "fixed" && !analysisPlotsWorkspaceStore.getSnapshot().range) return;
      preferences.setDescriptorRange(
        descriptorId,
        mode.mode === "fixed"
          ? { mode: "follow" }
          : mode,
      );
      analysisPlotsWorkspaceStore.setRangeMode(mode);
    },
    setTargetPoints: (points: typeof targetPoints) => {
      preferences.setDescriptorTargetPoints(descriptorId, points);
      analysisPlotsWorkspaceStore.setTargetPoints(points);
    },
    toggleSeriesVisibility: (seriesId: string) => {
      analysisPlotsWorkspaceStore.toggleSeriesVisibility(seriesId);
      const next = analysisPlotsWorkspaceStore.getSnapshot().hiddenSeriesIds;
      preferences.setDescriptorHiddenSeries(descriptorId, [...next]);
    },
    setSoloSeries: (seriesId: string | null, allSeriesIds?: readonly string[]) => {
      analysisPlotsWorkspaceStore.setSoloSeries(seriesId, allSeriesIds);
      preferences.setDescriptorSoloSeries(descriptorId, seriesId);
      preferences.setDescriptorHiddenSeries(
        descriptorId,
        [...analysisPlotsWorkspaceStore.getSnapshot().hiddenSeriesIds],
      );
    },
    clearHiddenSeries: () => {
      analysisPlotsWorkspaceStore.clearHiddenSeries();
      preferences.setDescriptorHiddenSeries(descriptorId, []);
      preferences.setDescriptorSoloSeries(descriptorId, null);
    },
    solverEnergySeries: energyData.solverEnergySeries,
    solverEnergyStatus: energyData.solverEnergyStatus,
    setXAxisId: (columnId: string) => {
      tableData.setXAxisId(columnId);
      const next = analysisPlotsWorkspaceStore.getSnapshot();
      preferences.setDescriptorXAxisId(descriptorId, next.xAxisId);
      preferences.setDescriptorYAxisIds(descriptorId, next.yAxisIds);
    },
    availableColumns: tableData.availableColumns,
    tableRowsStatus: tableRowsStatusForDisplay(
      tableData.tableRows.status,
      liveMode,
      Boolean(tableData.visibleTable && tableData.visibleTable.rowCount > 0),
    ),
    toggleYAxis: (columnId: string, enabled: boolean) => {
      tableData.toggleYAxis(columnId, enabled);
      preferences.setDescriptorYAxisIds(
        descriptorId,
        analysisPlotsWorkspaceStore.getSnapshot().yAxisIds,
      );
    },
    visibleTable: tableData.visibleTable,
    xAxisId: tableData.xAxisId,
    yAxisIds: tableData.yAxisIds,
    selectedStageId,
  };
}

export { frequencyDomainChartRouteOverrideFromSelection } from "@/shared/domain/analysis/frequencyDomainChartModels";
export { frequencyDomainChartTitle } from "./hooks/useAnalysisFrequencyData";

export function frequencyDomainSelectionFromPoint({
  dispersionModel,
  point,
  responseModel,
  routeMode,
  spectrumModel,
}: {
  dispersionModel: ReturnType<typeof buildEigenDispersionChartModel>;
  point: AnalysisChartCursorPoint;
  responseModel: ReturnType<typeof buildFrequencyResponseChartModel>;
  routeMode: ReturnType<typeof routeFrequencyDomainCalculationMode>["mode"];
  spectrumModel: ReturnType<typeof buildEigenSpectrumChartModel>;
}): Partial<Omit<Selection, "moduleSource">> | null {
  if (point.source.kind !== "analysis.frequency_domain") return null;
  const nodeId = analysisChartPointNodeId(point);
  const base = {
    calculationMode: routeMode,
    nodeId,
    resourceRef: point.source.resourceKey,
  };
  if (point.source.tableId === "frequency-domain:eigen-spectrum") {
    const spectrumPoint = spectrumModel.points[point.point.rowIndex];
    if (!spectrumPoint) return null;
    const ref = buildEigenModeSelectionRef(spectrumPoint, base);
    return {
      kind: ref.kind,
      label: `${point.label} ${formatAnalysisPointValue(point.point.y, point.unit)}`,
      nodeId,
      objectId: null,
      ref,
    };
  }

  if (point.source.tableId === "frequency-domain:eigen-dispersion") {
    const dispersionPoint = dispersionModel.points[point.point.rowIndex];
    if (!dispersionPoint) return null;
    const ref = buildEigenDispersionPointSelectionRef(dispersionPoint, base);
    return {
      kind: ref.kind,
      label: `${point.label} ${formatAnalysisPointValue(point.point.y, point.unit)}`,
      nodeId,
      objectId: null,
      ref,
    };
  }

  if (point.source.tableId === "frequency-domain:response-sweep") {
    const responsePoint = responseModel.points[point.point.rowIndex];
    if (!responsePoint) return null;
    const ref = buildFrequencyResponsePointSelectionRef(responsePoint, base);
    return {
      kind: ref.kind,
      label: `${point.label} ${formatAnalysisPointValue(point.point.y, point.unit)}`,
      nodeId,
      objectId: null,
      ref,
    };
  }

  return null;
}

function analysisChartPointNodeId(point: AnalysisChartCursorPoint): string {
  return `analysis:charts:${point.source.tableId}:point:${point.seriesId}:${point.point.rowIndex}`;
}

function analysisChartDescriptorId(surface: AnalysisWorkbenchSurface): string {
  if (surface === "energy") return "analysis:solver-energy-history";
  if (surface === "frequency") return "analysis:frequency-domain";
  return "analysis:data-table:default";
}

function emitRangeSelected(
  bus: KernelApi["bus"],
  range: ChartValueRange | null,
  xAxisId: string,
): void {
  const event = analysisPlotsRangeSelectedEvent({ range, xAxisId });
  bus.emit("analysis-plots:range-selected", {
    ...event,
    source: "analysis-plots",
  });
  recordChartRangeSelectedEvent(event);
}

export function selectedHysteresisStageIdFromSelection(
  state: Selection | null | undefined,
): string | null {
  if (!state) return null;
  const ref = state.ref;
  if (!ref) return null;
  const stageId = (ref as { stageId?: unknown }).stageId;
  if (typeof stageId === "string" && stageId.length > 0) {
    const kind = state.kind ?? "";
    const type = (ref as { type?: string }).type ?? "";
    if (
      stageId.startsWith("hysteresis") ||
      kind.includes("hysteresis") ||
      type.includes("hysteresis")
    ) {
      return stageId;
    }
  }
  return null;
}
