"use client";

import { useCallback, useEffect, useRef } from "react";

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
  chartSeriesIdBelongsToScope,
  initializeSelectedSeriesIdsForUnconfiguredScope,
  replaceSelectedSeriesIdsInScope,
  type ChartSeriesSelectionScope,
} from "@/shared/analysis-charts/chartSeriesSelection";

import {
  tableRowsStatusForDisplay,
  useAnalysisTableData,
} from "./hooks/useAnalysisTableData";
import { useAnalysisEnergyData } from "./hooks/useAnalysisEnergyData";
import { useAnalysisFrequencyData } from "./hooks/useAnalysisFrequencyData";

export function useAnalysisPlotsController(kernel: KernelApi) {
  const { bus, selection } = kernel;
  const { activeSurface, range, rangeMode, targetPoints, liveMode, selectedSeriesIds } =
    useAnalysisPlotsWorkspaceSelector((state) => state);
  const selectedPoint = useAnalysisPlotsWorkspaceSelector(
    (state) => state.selectedPoint,
  );

  // Wire preferences hydration (Etap 3)
  const descriptorId = analysisChartDescriptorId(activeSurface);
  const preferences = useAnalysisChartPreferencesHydration(descriptorId);
  const appliedActiveSurfaceRef = useRef(false);
  const appliedDescriptorRef = useRef<unknown>(null);

  const commitScopedSelection = useCallback(
    (
      scope: ChartSeriesSelectionScope,
      nextSelectedSeriesIds: readonly string[],
    ) => {
      const ownsSeriesId = (seriesId: string) =>
        chartSeriesIdBelongsToScope(scope, seriesId);
      const scopedSelection = nextSelectedSeriesIds.filter(ownsSeriesId);
      const mergedSelection = replaceSelectedSeriesIdsInScope(
        analysisPlotsWorkspaceStore.getSnapshot().selectedSeriesIds,
        scopedSelection,
        ownsSeriesId,
      );
      analysisPlotsWorkspaceStore.setSelectedSeriesIds(mergedSelection);
      preferences.setDescriptorSelectedSeriesIds(
        analysisChartDescriptorIdForScope(scope),
        scopedSelection,
      );
    },
    [preferences],
  );

  const commitTableSelection = useCallback(
    (nextSelectedSeriesIds: readonly string[]) =>
      commitScopedSelection("table", nextSelectedSeriesIds),
    [commitScopedSelection],
  );

  const commitTableXAxis = useCallback(
    (nextXAxisId: string, nextSelectedSeriesIds: readonly string[]) => {
      const scopedSelection = nextSelectedSeriesIds.filter((seriesId) =>
        chartSeriesIdBelongsToScope("table", seriesId),
      );
      const mergedSelection = replaceSelectedSeriesIdsInScope(
        analysisPlotsWorkspaceStore.getSnapshot().selectedSeriesIds,
        scopedSelection,
        (seriesId) => chartSeriesIdBelongsToScope("table", seriesId),
      );
      analysisPlotsWorkspaceStore.setTableSelection(nextXAxisId, mergedSelection);
      preferences.setDescriptorXAxisId("analysis:data-table:default", nextXAxisId);
      preferences.setDescriptorSelectedSeriesIds(
        "analysis:data-table:default",
        scopedSelection,
      );
    },
    [preferences],
  );

  useEffect(() => {
    if (!preferences.isHydrated) return;
    if (!appliedActiveSurfaceRef.current) {
      appliedActiveSurfaceRef.current = true;
      analysisPlotsWorkspaceStore.setActiveSurface(preferences.prefs.activeSurface);
    }
    const descriptor = preferences.descriptor;
    if (!descriptor || appliedDescriptorRef.current === descriptor) return;
    appliedDescriptorRef.current = descriptor;
    const scope = chartSeriesSelectionScopeForDescriptorId(descriptorId);
    const mergedSelection = replaceSelectedSeriesIdsInScope(
      analysisPlotsWorkspaceStore.getSnapshot().selectedSeriesIds,
      descriptor.selectedSeriesIds ?? [],
      (seriesId) => chartSeriesIdBelongsToScope(scope, seriesId),
    );
    analysisPlotsWorkspaceStore.setLiveMode(descriptor.liveMode);
    if (scope === "table") {
      analysisPlotsWorkspaceStore.setTableSelection(descriptor.xAxisId, mergedSelection);
    } else {
      analysisPlotsWorkspaceStore.setSelectedSeriesIds(mergedSelection);
    }
    analysisPlotsWorkspaceStore.setTargetPoints(descriptor.targetPoints);
    if (descriptor.range.mode === "fixed") {
      analysisPlotsWorkspaceStore.setRange({
        fromValue: descriptor.range.fromSI,
        toValue: descriptor.range.toSI,
      });
    } else {
      analysisPlotsWorkspaceStore.setRangeMode(descriptor.range);
    }
  }, [descriptorId, preferences.descriptor, preferences.isHydrated, preferences.prefs.activeSurface]);

  // Delegate data family loading to dedicated resource hooks (Etap 10)
  const tableData = useAnalysisTableData(kernel, {
    activeSurface,
    liveMode,
    range,
    rangeMode,
    targetPoints,
    onTableSelectionChange: commitTableSelection,
    onTableXAxisChange: commitTableXAxis,
  });
  const setDescriptorRange = preferences.setDescriptorRange;

  useEffect(() => {
    const normalized = normalizeTableRangeModeForXAxis(
      rangeMode,
      tableData.xAxisId,
    );
    if (normalized === rangeMode) return;
    setDescriptorRange(descriptorId, { mode: "follow" });
    analysisPlotsWorkspaceStore.setRangeMode(normalized);
  }, [descriptorId, rangeMode, setDescriptorRange, tableData.xAxisId]);

  const energyData = useAnalysisEnergyData(activeSurface);

  const frequencyData = useAnalysisFrequencyData(activeSurface);

  useEffect(() => {
    if (!preferences.isHydrated || preferences.descriptor?.selectedSeriesIds !== undefined) return;
    const scope = activeSurface === "energy"
      ? "energy"
      : activeSurface === "frequency"
        ? "frequency"
        : null;
    const availableSeriesIds = scope === "energy"
      ? energyData.solverEnergySeries.map((series) => series.id)
      : scope === "frequency"
        ? frequencyData.frequencyDomainSeries.map((series) => series.id)
        : [];
    if (!scope || availableSeriesIds.length === 0) return;
    const initialized = initializeSelectedSeriesIdsForUnconfiguredScope(
      analysisPlotsWorkspaceStore.getSnapshot().selectedSeriesIds,
      availableSeriesIds,
      false,
      (seriesId) => chartSeriesIdBelongsToScope(scope, seriesId),
    );
    commitScopedSelection(scope, initialized);
  }, [
    activeSurface,
    commitScopedSelection,
    energyData.solverEnergySeries,
    frequencyData.frequencyDomainSeries,
    preferences.descriptor,
    preferences.isHydrated,
  ]);

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
    setSelectedSeriesIds: (
      scope: ChartSeriesSelectionScope,
      nextSelectedSeriesIds: readonly string[],
    ) => commitScopedSelection(scope, nextSelectedSeriesIds),
    solverEnergySeries: energyData.solverEnergySeries,
    solverEnergyStatus: energyData.solverEnergyStatus,
    setXAxisId: (columnId: string) => {
      tableData.setXAxisId(columnId);
    },
    availableColumns: tableData.availableColumns,
    tableRowsStatus: tableData.tableRowsUnsupportedReason
      ? "unsupported"
      : tableRowsStatusForDisplay(
        tableData.tableRows.status,
        liveMode,
        Boolean(tableData.visibleTable && tableData.visibleTable.rowCount > 0),
      ),
    tableRowsRefresh: tableData.tableRows,
    tableRowsUnsupportedReason: tableData.tableRowsUnsupportedReason,
    visibleTable: tableData.visibleTable,
    xAxisId: tableData.xAxisId,
    selectedSeriesIds: tableData.selectedSeriesIds,
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

function analysisChartDescriptorIdForScope(
  scope: ChartSeriesSelectionScope,
): string {
  switch (scope) {
    case "energy":
      return "analysis:solver-energy-history";
    case "frequency":
      return "analysis:frequency-domain";
    case "table":
      return "analysis:data-table:default";
  }
}

function chartSeriesSelectionScopeForDescriptorId(
  descriptorId: string,
): ChartSeriesSelectionScope {
  if (descriptorId === "analysis:solver-energy-history") return "energy";
  if (descriptorId === "analysis:frequency-domain") return "frequency";
  return "table";
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
