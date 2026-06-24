"use client";

import { useEffect, useMemo } from "react";

import type { KernelApi } from "@/kernel/types";
import { analysisPlotsWorkspaceStore } from "@/kernel/workspace/analysisPlotsWorkspace";
import { useAnalysisPlotsWorkspaceSelector } from "@/kernel/workspace/useAnalysisPlotsWorkspace";
import {
  shouldLoadRuntimeScalars,
  useSolverEnergyHistoryResource,
  useFrequencyDomainEigenDispersionResource,
  useFrequencyDomainEigenSpectrumResource,
  useFrequencyDomainManifestResource,
  useFrequencyDomainResponseSweepResource,
  useTableColumnsResource,
  useTableRowsBinaryResource,
} from "@/kernel/resources/studyRuntimeResources";
import { useSessionStatusSelector } from "@/kernel/resources/useSessionStatus";
import { yAxisIdsAfterXAxisSelection } from "@/shared/domain/analysis/axisSelection";
import type { AnalysisChartCursorPoint } from "@/shared/domain/analysis/chartCursorPoint";
import { useSelectionSelector } from "@/kernel/selection/useSelection";
import type { Selection } from "@/kernel/selection/selectionTypes";
import { nextYAxisIdsForToggle } from "@/shared/domain/analysis/TableColumnList";

import type { ChartValueRange } from "./chartTableModel";
import type { ChartSeries } from "./chartTableModel";
import {
  analysisPlotsRangeSelectedEvent,
  analysisPlotsSeriesSelectedEvent,
  buildAnalysisPlotsTableQuery,
  formatAnalysisPointValue,
  resolveAnalysisPlotsRequestedSeriesYAxisIds,
  resolveAnalysisPlotsYAxisIds,
  shouldFetchAnalysisTableRows,
  stringArraysEqual,
} from "./analysisPlotsModel";
import {
  clearChartDispatchSeriesRequest,
  recordChartDispatchSeriesRequest,
  recordChartRangeSelectedEvent,
  recordChartSeriesSelectedEvent,
} from "./components/chartDiagnostics";
import { buildSolverEnergyHistoryChartSeries } from "./energyHistoryAdapter";
import {
  buildEigenDispersionPointSelectionRef,
  buildEigenDispersionChartModel,
  buildEigenModeSelectionRef,
  buildEigenSpectrumChartModel,
  buildFrequencyResponsePointSelectionRef,
  buildFrequencyResponseChartModel,
  type FrequencyDomainChartRoute,
  routeFrequencyDomainCalculationMode,
} from "@/shared/domain/analysis/frequencyDomainChartModels";
import { frequencyDomainChartSeriesForAnalysisPlots } from "./frequencyDomainSeriesAdapter";
import {
  ANALYSIS_SCALAR_COLUMNS,
  tableResourceReducer,
  tableRowsResourceFromBinary,
  tableRowsResourceFromScalarSample,
} from "./tableRowsAdapter";

export function useAnalysisPlotsController(kernel: KernelApi) {
  const { bus, selection } = kernel;
  const { range, tableState, xAxisId, yAxisIds } =
    useAnalysisPlotsWorkspaceSelector((state) => state);
  const selectedPoint = useAnalysisPlotsWorkspaceSelector(
    (state) => state.selectedPoint,
  );
  const { cursor, visibleTable } = tableState;

  const scalarsRevision = useSessionStatusSelector(
    (status) => status.data?.resources.scalars_revision ?? null,
  );
  const loadScalars = shouldLoadRuntimeScalars(
    true,
    scalarsRevision === null
      ? null
      : { resources: { scalars_revision: scalarsRevision } },
  );
  const tableQuery = useMemo(
    () => buildAnalysisPlotsTableQuery({ cursor, range, xAxisId }),
    [cursor, range, xAxisId],
  );
  const tableColumns = useTableColumnsResource("default", {
    enabled: loadScalars,
  });
  const tableRows = useTableRowsBinaryResource("default", {
    ...tableQuery,
    enabled: shouldFetchAnalysisTableRows({
      hasVisibleRows: Boolean(visibleTable && visibleTable.rows.length > 0),
      loadScalars,
      range,
    }),
  });
  const solverEnergyHistory = useSolverEnergyHistoryResource(400, {
    enabled: loadScalars,
  });
  const solverEnergySeries = useMemo(
    () =>
      buildSolverEnergyHistoryChartSeries(
        solverEnergyHistory.data,
        solverEnergyHistory.status,
      ),
    [solverEnergyHistory.data, solverEnergyHistory.status],
  );
  const frequencyDomainManifest = useFrequencyDomainManifestResource();
  const frequencyDomainManifestRoute = routeFrequencyDomainCalculationMode(
    frequencyDomainManifest.data?.result_manifest?.payload,
  );
  const frequencyDomainRouteOverride = useSelectionSelector(
    frequencyDomainChartRouteOverrideFromSelection,
  );
  const frequencyDomainRoute = {
    ...frequencyDomainManifestRoute,
    ...frequencyDomainRouteOverride,
  };
  const frequencyDomainSpectrum = useFrequencyDomainEigenSpectrumResource({
    enabled: frequencyDomainRoute.primaryChart === "modal-spectrum",
  });
  const frequencyDomainDispersion = useFrequencyDomainEigenDispersionResource({
    enabled: frequencyDomainRoute.primaryChart === "dispersion",
  });
  const frequencyDomainResponse = useFrequencyDomainResponseSweepResource({
    enabled: frequencyDomainRoute.primaryChart === "response-sweep",
  });
  const frequencyDomainSpectrumModel = useMemo(
    () => buildEigenSpectrumChartModel(frequencyDomainSpectrum.data),
    [frequencyDomainSpectrum.data],
  );
  const frequencyDomainDispersionModel = useMemo(
    () => buildEigenDispersionChartModel(frequencyDomainDispersion.data),
    [frequencyDomainDispersion.data],
  );
  const frequencyDomainResponseModel = useMemo(
    () =>
      buildFrequencyResponseChartModel(
        frequencyDomainResponse.data,
        frequencyDomainManifest.data?.result_manifest?.payload,
      ),
    [
      frequencyDomainManifest.data?.result_manifest?.payload,
      frequencyDomainResponse.data,
    ],
  );
  const frequencyDomainSeries = useMemo(() => {
    switch (frequencyDomainRoute.primaryChart) {
      case "dispersion":
        return frequencyDomainChartSeriesForAnalysisPlots(
          frequencyDomainDispersionModel,
        );
      case "modal-spectrum":
        return frequencyDomainChartSeriesForAnalysisPlots(
          frequencyDomainSpectrumModel,
        );
      case "response-sweep":
        return frequencyDomainChartSeriesForAnalysisPlots(
          frequencyDomainResponseModel,
        );
      case "response-map":
        return [];
    }
  }, [
    frequencyDomainDispersionModel,
    frequencyDomainRoute.primaryChart,
    frequencyDomainResponseModel,
    frequencyDomainSpectrumModel,
  ]);
  const frequencyDomainResourceStatus =
    frequencyDomainRoute.primaryChart === "dispersion"
      ? frequencyDomainDispersion.status
      : frequencyDomainRoute.primaryChart === "response-sweep"
        ? frequencyDomainResponse.status
        : frequencyDomainRoute.primaryChart === "modal-spectrum"
          ? frequencyDomainSpectrum.status
          : frequencyDomainRoute.primaryChart === "response-map"
            ? "error"
          : frequencyDomainManifest.status;

  const setXAxisId = (columnId: string) => {
    analysisPlotsWorkspaceStore.setAxes(
      columnId,
      resolveAnalysisPlotsYAxisIds(
        yAxisIdsAfterXAxisSelection(yAxisIds, columnId),
        tableColumns.data,
        columnId,
      ),
    );
  };
  const toggleYAxis = (columnId: string, enabled: boolean) => {
    analysisPlotsWorkspaceStore.setAxes(
      xAxisId,
      nextYAxisIdsForToggle(yAxisIds, columnId, enabled, {
        columns: tableColumns.data ?? undefined,
        xAxisId,
      }),
    );
  };
  const setRange = (nextRange: ChartValueRange) => {
    analysisPlotsWorkspaceStore.setRange(nextRange);
    emitRangeSelected(bus, nextRange, xAxisId);
  };
  const clearRange = () => {
    if (range) {
      analysisPlotsWorkspaceStore.setTableState({
        cursor: undefined,
        visibleTable: null,
      });
    }
    analysisPlotsWorkspaceStore.clearRange();
    emitRangeSelected(bus, null, xAxisId);
  };
  const selectPoint = (point: AnalysisChartCursorPoint) => {
    analysisPlotsWorkspaceStore.setSelectedPoint(point);
    const frequencyDomainSelection = frequencyDomainSelectionFromPoint({
      dispersionModel: frequencyDomainDispersionModel,
      point,
      responseModel: frequencyDomainResponseModel,
      routeMode: frequencyDomainRoute.mode,
      spectrumModel: frequencyDomainSpectrumModel,
    });
    if (frequencyDomainSelection) {
      selection.set(frequencyDomainSelection, "analysis-plots");
      return;
    }
    selection.set(
      {
        kind: "analysis.chart-point",
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
    bus.emit("charts:series-selected", {
      ...event,
      source: "analysis-plots",
    });
    recordChartSeriesSelectedEvent(event);
  };

  useEffect(() => {
    const columns = tableColumns.data;
    if (!columns) return;
    const sanitized = resolveAnalysisPlotsYAxisIds(yAxisIds, columns, xAxisId);
    if (stringArraysEqual(sanitized, yAxisIds)) return;
    analysisPlotsWorkspaceStore.setAxes(xAxisId, sanitized);
  }, [tableColumns.data, xAxisId, yAxisIds]);

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

  useEffect(() => {
    const decoded = tableRows.data;
    const columns = tableColumns.data;
    if (!decoded || decoded.status !== "ready" || !columns) return;
    const resource = tableRowsResourceFromBinary({
      columns,
      decoded: decoded.data,
      queryColumns: ANALYSIS_SCALAR_COLUMNS,
      tableId: "default",
    });
    if (!resource) return;
    const currentState = analysisPlotsWorkspaceStore.getSnapshot().tableState;
    analysisPlotsWorkspaceStore.setTableState(
      tableResourceReducer(currentState, {
        advanceCursor: range ? false : undefined,
        mode: range ? "replace" : "append",
        resource,
        type: "append",
      }),
    );
  }, [range, tableColumns.data, tableRows.data]);

  useEffect(() => {
    return bus.on("telemetry:scalar-sample", (sample) => {
      const columns = tableColumns.data;
      if (!columns) return;
      const resource = tableRowsResourceFromScalarSample({
        columns,
        queryColumns: ANALYSIS_SCALAR_COLUMNS,
        sample,
        tableId: "default",
      });
      if (!resource) return;
      const currentState = analysisPlotsWorkspaceStore.getSnapshot().tableState;
      analysisPlotsWorkspaceStore.setTableState(
        tableResourceReducer(currentState, {
          advanceCursor: false,
          resource,
          type: "append",
        }),
      );
    });
  }, [bus, tableColumns.data]);

  useEffect(() => {
    return bus.on("charts:add-series-requested", (request) => {
      if (request.tableId !== "default") return;
      const columns = tableColumns.data;
      if (!columns) return;
      const current = analysisPlotsWorkspaceStore.getSnapshot();
      const nextYAxisIds = resolveAnalysisPlotsRequestedSeriesYAxisIds({
        columnId: request.columnId,
        columns,
        xAxisId: current.xAxisId,
        yAxisIds: current.yAxisIds,
      });
      if (stringArraysEqual(nextYAxisIds, current.yAxisIds)) return;
      analysisPlotsWorkspaceStore.setAxes(current.xAxisId, nextYAxisIds);
    });
  }, [bus, tableColumns.data]);

  useEffect(() => {
    recordChartDispatchSeriesRequest((columnId) => {
      bus.emit("charts:add-series-requested", {
        columnId,
        source: "analysis-plots",
        tableId: "default",
      });
    });
    return clearChartDispatchSeriesRequest;
  }, [bus]);

  const selectedStageId = useSelectionSelector(
    selectedHysteresisStageIdFromSelection,
  );

  return {
    clearRange,
    range,
    selectedPoint,
    selectPoint,
    selectSeries,
    setRange,
    frequencyDomainSeries,
    frequencyDomainStatus:
      frequencyDomainRoute.primaryChart === "response-map"
        ? "error"
        : frequencyDomainRoute.status === "available"
        ? frequencyDomainResourceStatus
        : frequencyDomainManifest.status === "ready"
          ? "stale"
          : frequencyDomainManifest.status,
    frequencyDomainTitle: frequencyDomainChartTitle(
      frequencyDomainRoute.primaryChart,
      frequencyDomainRoute.mode,
    ),
    frequencyDomainUnavailableReason:
      frequencyDomainRoute.primaryChart === "response-map"
        ? "response-map chart adapter is not available yet"
        : frequencyDomainRoute.unavailableReason ??
          firstFrequencyDomainDiagnostic([
            frequencyDomainDispersionModel.diagnostics,
            frequencyDomainResponseModel.diagnostics,
            frequencyDomainSpectrumModel.diagnostics,
          ]),
    solverEnergySeries,
    solverEnergyStatus: solverEnergyHistory.status,
    setXAxisId,
    tableRowsStatus: tableRows.status,
    toggleYAxis,
    visibleTable,
    xAxisId,
    yAxisIds,
    selectedStageId,
  };
}

export function frequencyDomainChartRouteOverrideFromSelection(
  state: Selection,
): Pick<FrequencyDomainChartRoute, "mode" | "primaryChart"> | null {
  const kind = state.ref?.type === "frequency-domain"
    ? state.ref.kind
    : state.kind;
  if (!kind) return null;
  if (kind === "results.frequency_domain.fmr_modal_spectrum") {
    return { mode: "fmr_modal", primaryChart: "modal-spectrum" };
  }
  if (
    kind.startsWith("results.frequency_response") ||
    kind.startsWith("resources.analysis.frequency_response") ||
    kind === "study.stage.frequency_response.sweep" ||
    kind === "study.stage.frequency_response.outputs" ||
    kind === "results.frequency_domain.fmr_response_sweep"
  ) {
    return { mode: "fmr_response", primaryChart: "response-sweep" };
  }
  if (
    kind === "results.frequency_domain.response_map" ||
    kind === "resources.analysis.frequency_domain.response_map" ||
    kind === "study.stage.frequency_response.k_grid"
  ) {
    return { mode: "response_map", primaryChart: "response-map" };
  }
  if (
    kind.includes("dispersion") ||
    kind.includes("k_path") ||
    kind === "study.stage.eigenmodes.k_path"
  ) {
    return { mode: "dispersion_modal", primaryChart: "dispersion" };
  }
  if (
    kind.startsWith("results.eigen") ||
    kind.startsWith("resources.analysis.eigen") ||
    kind === "study.stage.eigenmodes.outputs"
  ) {
    return { mode: "free_modes", primaryChart: "modal-spectrum" };
  }
  return null;
}

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

export function frequencyDomainChartTitle(
  primaryChart: string,
  mode: string,
): string {
  switch (primaryChart) {
    case "dispersion":
      return "Frequency-domain dispersion";
    case "modal-spectrum":
      if (mode === "fmr_modal") return "FMR modal spectrum";
      return "Frequency-domain modal spectrum";
    case "response-sweep":
      if (mode === "fmr_response") return "FMR response sweep";
      return "Frequency-domain response sweep";
    case "response-map":
      return "Frequency-domain response map";
    default:
      return "Frequency-domain analysis";
  }
}

function firstFrequencyDomainDiagnostic(
  diagnosticGroups: readonly (readonly string[])[],
): string | null {
  for (const diagnostics of diagnosticGroups) {
    for (const diagnostic of diagnostics) {
      if (diagnostic.length > 0) return diagnostic;
    }
  }
  return null;
}

function analysisChartPointNodeId(point: AnalysisChartCursorPoint): string {
  return `analysis:charts:${point.source.tableId}:point:${point.seriesId}:${point.point.rowIndex}`;
}

export function selectedHysteresisStageIdFromSelection(
  state: Selection,
): string | null {
  const ref = state.ref;
  if (state.kind === "study.stage.hysteresis" && ref?.type === "study-stage") {
    return ref.stageId;
  }
  if (ref?.type === "hysteresis-snapshot") {
    return ref.stageId;
  }
  if (ref?.type === "analysis-chart-point" && ref.stageId) {
    return ref.stageId;
  }
  if (
    state.kind === "study.stage.action" &&
    ref?.type === "study-stage" &&
    isHysteresisStageActionNodeId(ref.nodeId)
  ) {
    return ref.stageId;
  }
  return null;
}

function isHysteresisStageActionNodeId(nodeId: string): boolean {
  return [
    ":plan",
    ":protocol",
    ":orientation",
    ":saturation",
    ":adaptive-refinement",
    ":angular-family",
    ":settle-pipeline",
    ":live-run",
    ":branches",
    ":points",
    ":metrics",
    ":snapshots",
    ":field-point",
    ":field-current",
    ":transitions",
  ].some((suffix) => nodeId.includes(suffix));
}

function emitRangeSelected(
  bus: KernelApi["bus"],
  range: ChartValueRange | null,
  xAxisId: string,
): void {
  const event = analysisPlotsRangeSelectedEvent({ range, xAxisId });
  bus.emit("charts:range-selected", {
    ...event,
    source: "analysis-plots",
  });
  recordChartRangeSelectedEvent(event);
}
