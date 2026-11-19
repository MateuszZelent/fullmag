"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { liveChartsWorkspaceStore } from "@/kernel/workspace/liveChartsWorkspace";
import { useLiveChartPreferencesHydration } from "@/kernel/workspace/useLiveChartPreferencesHydration";
import { liveChartPreferencesStore } from "@/kernel/workspace/liveChartPreferences";
import type { ChartRangePreference } from "@/kernel/workspace/liveChartPreferences";
import { useLiveChartsWorkspaceSelector } from "@/kernel/workspace/useLiveChartsWorkspace";
import type { SelectionController } from "@/kernel/selection/SelectionController";
import type { LayoutController } from "@/kernel/layout/LayoutController";
import { deriveChartPresentationState } from "@/shared/analysis-charts/chartPresentationState";
import type { ChartDataPresentationState, ChartResourceSnapshot } from "@/shared/analysis-charts/chartPresentationState";
import type { ChartSeries } from "@/shared/domain/analysis/chartSeries";
import { buildScalarChartSeries } from "@/shared/domain/analysis/scalarTableChart";

import { useLiveEnergyData } from "./hooks/useLiveEnergyData";
import { useLiveTableData } from "./hooks/useLiveTableData";
import { useLiveChartArchivedTable } from "./hooks/useLiveChartArchivedTable";
import {
  isLiveChartServerXAxisId,
  liveChartDescriptorDefaults,
  liveChartInitialRange,
  liveChartPreset,
  liveChartRangesEqual,
  normalizeLiveChartRangeForXAxis,
  type LiveChartPresetId,
} from "./liveChartsModel";
import { liveChartsCommandRequests } from "./liveChartsCommandRequests";
import { resolveLiveChartSelectedSeriesIds } from "./liveChartsSelection";
import { liveChartXAxisOptions } from "./liveChartsPresentation";
import type { LiveChartsExportRequest } from "./liveChartsViewTypes";

type LiveChartPreferencesActions = Pick<
  ReturnType<typeof useLiveChartPreferencesHydration>,
  "setDescriptorLiveMode" | "setDescriptorRange" | "setDescriptorSelectedSeriesIds"
>;
interface LiveChartsLocalExportState {
  errorFormat: LiveChartsExportRequest["format"] | null;
  request: LiveChartsExportRequest | null;
}
type LiveChartsStateSetter<T> = (value: T | ((current: T) => T)) => void;
type LiveChartsCommandAction = NonNullable<ReturnType<typeof liveChartsCommandRequests.getSnapshot>>;
let liveChartsLocalExportSequence = 0;

export function createLiveChartSelectionHandlers({
  descriptorId,
  selection,
}: {
  descriptorId: string;
  selection: SelectionController;
}) {
  const chartNodeId = `live:chart:${encodeURIComponent(descriptorId)}`;
  return {
    onChartSelected: () => {
      selection.set({
        kind: "live.chart",
        label: "Live Chart",
        nodeId: chartNodeId,
        objectId: null,
        ref: {
          descriptorId,
          kind: "live.chart",
          nodeId: chartNodeId,
          type: "live-chart",
        },
      }, "live-charts");
    },
    onPointSelected: (
      seriesId: string,
      pointIndex: number,
      revision: string | number,
    ) => {
      const nodeId = `${chartNodeId}:point:${encodeURIComponent(seriesId)}:${pointIndex}:${encodeURIComponent(String(revision))}`;
      selection.set({
        kind: "live.chart-point",
        label: `${seriesId} point ${pointIndex}`,
        nodeId,
        objectId: null,
        ref: {
          descriptorId,
          kind: "live.chart-point",
          nodeId,
          pointIndex,
          revision,
          seriesId,
          type: "live-chart-point",
        },
      }, "live-charts");
    },
  };
}

export function ensureLiveChartsInspectorVisible(
  {
    layout,
    selection,
  }: {
    layout: Pick<LayoutController, "setFocusedSlot" | "setPanelVisible">;
    selection: SelectionController;
  },
  descriptorId: string,
): void {
  const current = selection.get();
  const isCurrentLiveChart = current.kind === "live.chart" || current.kind === "live.chart-point";
  const currentDescriptorId = current.ref?.type === "live-chart" || current.ref?.type === "live-chart-point"
    ? current.ref.descriptorId
    : null;
  if (!isCurrentLiveChart || currentDescriptorId !== descriptorId) {
    createLiveChartSelectionHandlers({ descriptorId, selection }).onChartSelected();
  }
  layout.setPanelVisible("right", true);
  layout.setFocusedSlot("panel-right");
}

export function useLiveChartsController(selection: SelectionController) {
  const selectedDescriptorId = useLiveChartsWorkspaceSelector((state) => state.selectedDescriptorId);
  const descriptorId = (selectedDescriptorId ?? "magnetization") as LiveChartPresetId;
  const preferences = useLiveChartPreferencesHydration(descriptorId);
  // Defaults are a fresh object per call; keep one per descriptor so that derived
  // selection and effect dependencies stay referentially stable across renders.
  const defaults = useMemo(() => liveChartDescriptorDefaults(descriptorId), [descriptorId]);
  const descriptor = preferences.descriptor ?? defaults;
  const rangeMode = descriptor.range.mode;
  const rangeFromSI = rangeMode === "fixed" ? descriptor.range.fromSI : null;
  const rangeToSI = rangeMode === "fixed" ? descriptor.range.toSI : null;
  const initialRange = useMemo(
    () => rangeMode === "fixed" && rangeFromSI !== null && rangeToSI !== null
      ? liveChartInitialRange({ mode: "fixed", fromSI: rangeFromSI, toSI: rangeToSI })
      : null,
    [rangeFromSI, rangeMode, rangeToSI],
  );
  const commandAction = useSyncExternalStore(liveChartsCommandRequests.subscribe, liveChartsCommandRequests.getSnapshot, liveChartsCommandRequests.getSnapshot);
  const commandFitRequest = useSyncExternalStore(liveChartsCommandRequests.subscribe, liveChartsCommandRequests.getFitRequestSnapshot, liveChartsCommandRequests.getFitRequestSnapshot);
  const paused = descriptor.liveMode === "paused";
  const tableData = useLiveTableData({ active: descriptorId !== "energy", paused, range: descriptor.range, targetPoints: descriptor.targetPoints, xAxisId: descriptor.xAxisId });
  const archivedTable = useLiveChartArchivedTable({
    active: descriptorId !== "energy",
    columns: tableData.columns.data,
    currentSeries: tableData.currentSeriesIdentity,
    paused,
    range: tableData.range,
  });
  const liveTableView = useMemo<LiveChartTableView>(() => ({
    archived: archivedTable !== null,
    columns: tableData.columns.data,
    descriptorId,
    error: tableData.rows.error,
    range: tableData.range,
    revision: tableData.rows.revision,
    scope: tableData.sessionScopeKey,
    status: tableData.rows.status,
    table: archivedTable ?? tableData.table,
    unsupportedReason: tableData.unsupportedReason,
    xAxisId: tableData.xAxisId,
  }), [
    archivedTable, descriptorId, tableData.columns.data, tableData.range, tableData.rows.error,
    tableData.rows.revision, tableData.rows.status, tableData.sessionScopeKey, tableData.table,
    tableData.unsupportedReason, tableData.xAxisId,
  ]);
  const [lastTableView, setLastTableView] = useState<LiveChartTableView | null>(null);
  const sameScope = lastTableView !== null && liveTableView.scope !== null &&
    lastTableView.scope === liveTableView.scope && lastTableView.descriptorId === descriptorId;
  if (lastTableView && !sameScope) {
    setLastTableView(null);
  } else if (!paused && liveTableView.scope && lastTableView !== liveTableView) {
    setLastTableView(liveTableView);
  }
  const tableView = paused ? (sameScope ? lastTableView : null) : liveTableView;
  const chartTable = tableView?.table ?? null;
  const effectiveTableXAxisId = tableView?.xAxisId ?? descriptor.xAxisId;
  const energyData = useLiveEnergyData({ active: true, descriptorId, paused });
  const [localFitRequest, setLocalFitRequest] = useState(0);
  const [localExportState, setLocalExportState] = useState<LiveChartsLocalExportState>({ errorFormat: null, request: null });
  const localExportRequest = localExportState.request;
  const exportErrorFormat = localExportState.errorFormat;
  useEffect(() => {
    clearLiveChartsExportError(setLocalExportState);
  }, [descriptorId]);
  const onExport = (format: LiveChartsExportRequest["format"]) => {
    setLocalExportState({
      errorFormat: null,
      request: {
        format,
        requestId: `live-charts-local-export-${++liveChartsLocalExportSequence}`,
      },
    });
  };
  const fitRequest = commandFitRequest + localFitRequest;
  const commandExportRequest = commandExportRequestFromAction(commandAction);
  const requestedExportRequest = commandExportRequest ?? localExportRequest;
  const requestedExportRequestId = requestedExportRequest?.requestId ?? null;
  useEffect(() => {
    if (!preferences.isHydrated || preferences.descriptor) return;
    liveChartPreferencesStore.updateDescriptor(descriptorId, () => defaults);
  }, [defaults, descriptorId, preferences.descriptor, preferences.isHydrated]);
  useEffect(() => {
    if (!preferences.isHydrated || descriptorId === "energy" || paused || !tableData.columns.data) return;
    const axisChanged = tableData.xAxisId !== descriptor.xAxisId;
    const rangeChanged = !liveChartRangesEqual(tableData.range, descriptor.range);
    if (!axisChanged && !rangeChanged) return;
    liveChartsWorkspaceStore.clearRange();
    liveChartPreferencesStore.updateDescriptor(descriptorId, () => ({
      range: tableData.range,
      xAxisId: tableData.xAxisId,
    }));
  }, [descriptor.range, descriptor.xAxisId, descriptorId, paused, preferences.isHydrated, tableData.columns.data, tableData.range, tableData.xAxisId]);
  useEffect(() => {
    if (!commandAction) return;
    applyLiveChartsCommand({ action: commandAction, descriptorId, preferences, setLocalExportState, tableXAxisId: effectiveTableXAxisId });
  }, [commandAction, descriptorId, effectiveTableXAxisId, preferences]);
  // Series depend only on whether the rows resource failed, not on every
  // loading/ready transition of a background refresh that keeps the same table.
  const tableRowsFailed = !tableView?.archived && tableView?.status === "error";
  const tableSeries = useMemo(
    () => buildLiveChartsTableSeries(chartTable, tableRowsFailed, effectiveTableXAxisId),
    [chartTable, effectiveTableXAxisId, tableRowsFailed],
  );
  const allSeries = resolveLiveChartsSeries(descriptorId, energyData.series, tableSeries);
  const persistedSelectedSeriesIds = descriptor.selectedSeriesIds;
  const defaultSelectedSeriesIds = defaults.selectedSeriesIds;
  const selectedSeriesIds = useMemo(
    () => resolveLiveChartSelectedSeriesIds(
      persistedSelectedSeriesIds,
      allSeries,
      defaultSelectedSeriesIds,
    ),
    [allSeries, defaultSelectedSeriesIds, persistedSelectedSeriesIds],
  );
  const series = allSeries;
  const selectionHandlers = createLiveChartSelectionHandlers({ descriptorId, selection });
  const presentationSnapshot = liveChartsPresentationSnapshot({
    descriptorId, energyData, tableView,
  });
  const {
    error: presentationError,
    hasData: presentationHasData,
    isEmpty: presentationIsEmpty,
    requestedRevision: presentationRequestedRevision,
    status: presentationStatus,
    unsupportedReason: presentationUnsupportedReason,
    visibleRevision: presentationVisibleRevision,
  } = presentationSnapshot;
  // The presentation object feeds chart model memos downstream; rebuild it only
  // when one of its primitive inputs changes so unrelated renders keep its identity.
  const presentation = useMemo(
    () => deriveLiveChartsPresentation({
      error: presentationError,
      hasData: presentationHasData,
      isEmpty: presentationIsEmpty,
      paused,
      requestedRevision: presentationRequestedRevision,
      status: presentationStatus,
      unsupportedReason: presentationUnsupportedReason,
      visibleRevision: presentationVisibleRevision,
    }),
    [
      paused,
      presentationError,
      presentationHasData,
      presentationIsEmpty,
      presentationRequestedRevision,
      presentationStatus,
      presentationUnsupportedReason,
      presentationVisibleRevision,
    ],
  );
  const effectiveXAxisId = resolveLiveChartsXAxisId(descriptorId, effectiveTableXAxisId);
  const viewMetadata = deriveLiveChartsViewMetadata({
    descriptor, descriptorId, effectiveXAxisId,
    tableRange: tableView?.range ?? descriptor.range,
    tableColumns: tableView?.columns ?? null,
  });
  const viewActions = createLiveChartsViewActions({
    commandExportRequest,
    descriptorId,
    effectiveXAxisId,
    onExport,
    paused,
    preferences,
    requestedExportRequest,
    requestedExportRequestId,
    setLocalExportState,
    setLocalFitRequest,
  });
  return {
    ...viewActions,
    ...selectionHandlers,
    descriptorId,
    exportErrorFormat,
    fitRequest,
    initialRange,
    isFollowing: !paused,
    presentation,
    requestedExportRequest,
    series,
    selectedSeriesIds,
    ...viewMetadata,
  };
}

function commandExportRequestFromAction(action: LiveChartsCommandAction | null): LiveChartsExportRequest | null {
  if (action?.kind !== "export") return null;
  return {
    format: action.format,
    requestId: action.requestId ?? `live-charts-command-export-${action.format}`,
  };
}

function buildLiveChartsTableSeries(
  table: ReturnType<typeof useLiveTableData>["table"],
  rowsFailed: boolean,
  xAxisId: string,
): ChartSeries[] {
  if (!table) return [];
  return buildScalarChartSeries({ ...table, valueAt: (rowIndex, columnIndex) => table.values[rowIndex * table.columnCount + columnIndex] }, {
    dataRevision: table.seriesRevision ?? table.revision,
    status: rowsFailed ? "error" : "ready",
    tableId: "default",
    unitLayout: "split-panes",
    xAxisId,
    yAxisIds: table.columns.reduce<string[]>((ids, column) => {
      if (column.column_id !== xAxisId) ids.push(column.column_id);
      return ids;
    }, []),
  });
}

function resolveLiveChartsSeries(
  descriptorId: LiveChartPresetId,
  energySeries: readonly ChartSeries[],
  tableSeries: readonly ChartSeries[],
): readonly ChartSeries[] {
  return descriptorId === "energy" ? energySeries : tableSeries;
}

interface LiveChartTableView {
  archived: boolean;
  columns: ReturnType<typeof useLiveTableData>["columns"]["data"];
  descriptorId: LiveChartPresetId;
  error: Error | null;
  range: ReturnType<typeof useLiveTableData>["range"];
  revision: string | number | null;
  scope: string | null;
  status: ReturnType<typeof useLiveTableData>["rows"]["status"];
  table: ReturnType<typeof useLiveTableData>["table"];
  unsupportedReason: string | null;
  xAxisId: string;
}

interface LiveChartsPresentationSnapshot {
  error: Error | null;
  hasData: boolean;
  isEmpty: boolean;
  requestedRevision: string | number | null;
  status: ChartResourceSnapshot<unknown>["status"];
  unsupportedReason: string | null;
  visibleRevision: string | number | null;
}

function liveChartsPresentationSnapshot({
  descriptorId,
  energyData,
  tableView,
}: {
  descriptorId: LiveChartPresetId;
  energyData: ReturnType<typeof useLiveEnergyData>;
  tableView: LiveChartTableView | null;
}): LiveChartsPresentationSnapshot {
  if (descriptorId === "energy") {
    const { data, error, revision, status } = energyData.resource;
    return {
      error, hasData: data !== null, isEmpty: data?.rows.length === 0,
      requestedRevision: revision, status, unsupportedReason: null,
      visibleRevision: data?.revision ?? null,
    };
  }
  if (tableView?.archived && tableView.table) {
    const revision = tableView.table.seriesRevision ?? tableView.table.revision;
    return {
      error: null, hasData: true, isEmpty: tableView.table.rowCount === 0,
      requestedRevision: revision, status: "ready", unsupportedReason: null, visibleRevision: revision,
    };
  }

  return {
    error: tableView?.error ?? null,
    hasData: Boolean(tableView?.table),
    isEmpty: tableView?.table?.rowCount === 0,
    requestedRevision: tableView?.revision ?? null,
    status: tableView?.unsupportedReason ? "unsupported" : tableView?.status ?? "idle",
    unsupportedReason: tableView?.unsupportedReason ?? null,
    visibleRevision: tableView?.table?.revision ?? null,
  };
}

function deriveLiveChartsPresentation({
  paused,
  ...snapshot
}: LiveChartsPresentationSnapshot & { paused: boolean }): ChartDataPresentationState {
  return deriveChartPresentationState({
    content: snapshot.isEmpty ? "empty" : undefined,
    // Only presence matters to the presentation state; the payload itself is not read.
    data: snapshot.hasData ? true : null,
    error: snapshot.error,
    requestedRevision: snapshot.requestedRevision,
    status: snapshot.status,
    unsupportedReason: snapshot.unsupportedReason,
    visibleRevision: snapshot.visibleRevision,
  }, { latestKnownRevision: snapshot.requestedRevision, paused });
}

function resolveLiveChartsXAxisId(descriptorId: LiveChartPresetId, tableXAxisId: string): string {
  return descriptorId === "energy" ? "t" : tableXAxisId;
}

function deriveLiveChartsViewMetadata({
  descriptor,
  descriptorId,
  effectiveXAxisId,
  tableRange,
  tableColumns,
}: {
  descriptor: ReturnType<typeof liveChartDescriptorDefaults>;
  descriptorId: LiveChartPresetId;
  effectiveXAxisId: string;
  tableRange: LiveChartTableView["range"];
  tableColumns: LiveChartTableView["columns"];
}) {
  return {
    range: descriptorId === "energy" ? descriptor.range : tableRange,
    title: liveChartPreset(descriptorId).title,
    xAxisId: effectiveXAxisId,
    xAxisLabel: liveChartsXAxisLabel(effectiveXAxisId),
    xAxisOptions: descriptorId === "energy"
      ? [{ id: "t", label: "Time (s)" }]
      : liveChartXAxisOptions(tableColumns ?? []),
  };
}

function liveChartsXAxisLabel(xAxisId: string): string {
  if (xAxisId === "t" || xAxisId === "time") return "Time";
  if (xAxisId === "step") return "Step";
  return xAxisId;
}

function createLiveChartsViewActions({
  commandExportRequest,
  descriptorId,
  effectiveXAxisId,
  onExport,
  paused,
  preferences,
  requestedExportRequest,
  requestedExportRequestId,
  setLocalExportState,
  setLocalFitRequest,
}: {
  commandExportRequest: LiveChartsExportRequest | null;
  descriptorId: LiveChartPresetId;
  effectiveXAxisId: string;
  onExport: (format: LiveChartsExportRequest["format"]) => void;
  paused: boolean;
  preferences: LiveChartPreferencesActions;
  requestedExportRequest: LiveChartsExportRequest | null;
  requestedExportRequestId: string | null;
  setLocalExportState: LiveChartsStateSetter<LiveChartsLocalExportState>;
  setLocalFitRequest: LiveChartsStateSetter<number>;
}) {
  return {
    onDescriptorChange: (next: LiveChartPresetId) => liveChartsWorkspaceStore.setSelectedDescriptorId(next),
    onExport,
    onFit: () => setLocalFitRequest((value) => value + 1),
    onRangeSelected: (fromSI: number, toSI: number) => {
      if (descriptorId !== "energy" && !isLiveChartServerXAxisId(effectiveXAxisId)) return;
      liveChartsWorkspaceStore.setRange({ fromSI, toSI });
      preferences.setDescriptorRange(descriptorId, { mode: "fixed", fromSI, toSI });
    },
    onSeriesChange: (ids: string[]) => preferences.setDescriptorSelectedSeriesIds(descriptorId, ids),
    onRequestedExportHandled: () => {
      if (commandExportRequest && isCurrentExportCommand(commandExportRequest.requestId)) {
        clearLiveChartsExportError(setLocalExportState);
        liveChartsCommandRequests.complete();
      } else if (!commandExportRequest && requestedExportRequestId) {
        setLocalExportState((current) => current.request?.requestId === requestedExportRequestId
          ? { errorFormat: null, request: null }
          : current);
      }
    },
    onRequestedExportFailed: () => {
      if (commandExportRequest && isCurrentExportCommand(commandExportRequest.requestId)) {
        liveChartsCommandRequests.fail();
      } else if (!commandExportRequest && requestedExportRequest && requestedExportRequestId) {
        setLocalExportState((current) => current.request?.requestId === requestedExportRequestId
          ? { errorFormat: requestedExportRequest.format, request: null }
          : current);
      }
    },
    onToggleFollow: () => preferences.setDescriptorLiveMode(descriptorId, paused ? "following" : "paused"),
    onXAxisChange: (id: string) => {
      if (!isLiveChartServerXAxisId(id)) return;
      liveChartsWorkspaceStore.clearRange();
      liveChartPreferencesStore.updateDescriptor(descriptorId, () => ({
        range: { mode: "follow" },
        xAxisId: id,
      }));
      setLocalFitRequest((value) => value + 1);
    },
    onRangeChange: descriptorId === "energy" ? undefined : (range: ChartRangePreference) => {
      liveChartsWorkspaceStore.clearRange();
      preferences.setDescriptorRange(descriptorId, normalizeLiveChartRangeForXAxis(range, effectiveXAxisId));
      setLocalFitRequest((value) => value + 1);
    },
  };
}

function clearLiveChartsExportError(
  setLocalExportState: LiveChartsStateSetter<LiveChartsLocalExportState>,
): void {
  setLocalExportState((current) => current.errorFormat === null
    ? current
    : { ...current, errorFormat: null });
}

function applyLiveChartsCommand({
  action,
  descriptorId,
  preferences,
  setLocalExportState,
  tableXAxisId,
}: {
  action: Exclude<NonNullable<ReturnType<typeof liveChartsCommandRequests.getSnapshot>>, null>;
  descriptorId: string;
  preferences: LiveChartPreferencesActions;
  setLocalExportState: LiveChartsStateSetter<LiveChartsLocalExportState>;
  tableXAxisId: string;
}): void {
  if (action.kind === "export") {
    clearLiveChartsExportError(setLocalExportState);
    return;
  }
  if (action.kind === "fit") {
    liveChartsCommandRequests.complete();
    return;
  }
  if (action.kind === "set-live-mode") {
    if (!action.descriptorId || action.descriptorId === descriptorId) {
      preferences.setDescriptorLiveMode(descriptorId, action.liveMode);
    }
    liveChartsCommandRequests.complete();
    return;
  }
  if (action.kind === "set-selected-series") {
    if (action.descriptorId === descriptorId) {
      preferences.setDescriptorSelectedSeriesIds(descriptorId, action.selectedSeriesIds);
    }
    liveChartsCommandRequests.complete();
    return;
  }
  if (action.kind === "set-range") {
    if (action.descriptorId === descriptorId) {
      const nextRange = descriptorId === "energy"
        ? action.range
        : normalizeLiveChartRangeForXAxis(action.range, tableXAxisId);
      if (nextRange.mode === "fixed") {
        liveChartsWorkspaceStore.setRange({ fromSI: nextRange.fromSI, toSI: nextRange.toSI });
      } else {
        liveChartsWorkspaceStore.clearRange();
      }
      preferences.setDescriptorRange(descriptorId, nextRange);
    }
    liveChartsCommandRequests.complete();
    return;
  }
  liveChartsWorkspaceStore.setSelectedDescriptorId(action.descriptorId);
  liveChartsCommandRequests.complete();
}

function isCurrentExportCommand(requestId: string): boolean {
  const action = liveChartsCommandRequests.getSnapshot();
  return action?.kind === "export" && action.requestId === requestId;
}
