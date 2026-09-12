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
import { buildScalarChartSeries } from "@/shared/domain/analysis/scalarTableChart";

import { useLiveEnergyData } from "./hooks/useLiveEnergyData";
import { useLiveTableData } from "./hooks/useLiveTableData";
import {
  isLiveChartServerXAxisId,
  isLiveChartTimeXAxisId,
  liveChartDescriptorDefaults,
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
  const defaults = liveChartDescriptorDefaults(descriptorId);
  const descriptor = preferences.descriptor ?? defaults;
  const commandAction = useSyncExternalStore(liveChartsCommandRequests.subscribe, liveChartsCommandRequests.getSnapshot, liveChartsCommandRequests.getSnapshot);
  const commandFitRequest = useSyncExternalStore(liveChartsCommandRequests.subscribe, liveChartsCommandRequests.getFitRequestSnapshot, liveChartsCommandRequests.getFitRequestSnapshot);
  const paused = descriptor.liveMode === "paused";
  const tableData = useLiveTableData({ active: descriptorId !== "energy", paused, range: descriptor.range, targetPoints: descriptor.targetPoints, xAxisId: descriptor.xAxisId });
  const energyData = useLiveEnergyData({ active: true, descriptorId, paused });
  const [localFitRequest, setLocalFitRequest] = useState(0);
  const [localExportState, setLocalExportState] = useState<LiveChartsLocalExportState>({ errorFormat: null, request: null });
  const localExportRequest = localExportState.request;
  const exportErrorFormat = localExportState.errorFormat;
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
  const commandExportRequest: LiveChartsExportRequest | null = commandAction?.kind === "export"
    ? {
        format: commandAction.format,
        requestId: commandAction.requestId ?? `live-charts-command-export-${commandAction.format}`,
      }
    : null;
  const requestedExportRequest = commandExportRequest ?? localExportRequest;
  const requestedExportRequestId = requestedExportRequest?.requestId ?? null;
  useEffect(() => {
    if (!preferences.isHydrated || preferences.descriptor) return;
    liveChartPreferencesStore.updateDescriptor(descriptorId, () => defaults);
  }, [defaults, descriptorId, preferences.descriptor, preferences.isHydrated]);
  useEffect(() => {
    if (!preferences.isHydrated || descriptorId === "energy") return;
    const axisChanged = tableData.xAxisId !== descriptor.xAxisId;
    const rangeChanged = !liveChartRangesEqual(tableData.range, descriptor.range);
    if (!axisChanged && !rangeChanged) return;
    liveChartsWorkspaceStore.clearRange();
    liveChartPreferencesStore.updateDescriptor(descriptorId, () => ({
      range: tableData.range,
      xAxisId: tableData.xAxisId,
    }));
  }, [descriptor.range, descriptor.xAxisId, descriptorId, preferences.isHydrated, tableData.range, tableData.xAxisId]);
  useEffect(() => {
    if (!commandAction) return;
    applyLiveChartsCommand({ action: commandAction, descriptorId, preferences, tableXAxisId: tableData.xAxisId });
  }, [commandAction, descriptorId, preferences, tableData.xAxisId]);
  const effectiveTableXAxisId = tableData.xAxisId;
  const tableSeries = useMemo(() => tableData.table ? buildScalarChartSeries({ ...tableData.table, valueAt: (rowIndex, columnIndex) => tableData.table!.values[rowIndex * tableData.table!.columnCount + columnIndex] }, {
    dataRevision: tableData.table.revision,
    status: tableData.rows.status === "error" ? "error" : "ready",
    tableId: "default",
    unitLayout: "split-panes",
    xAxisId: effectiveTableXAxisId,
    yAxisIds: tableData.table.columns.reduce<string[]>((ids, column) => {
      if (column.column_id !== effectiveTableXAxisId) ids.push(column.column_id);
      return ids;
    }, []),
  }) : [], [effectiveTableXAxisId, tableData.rows.status, tableData.table]);
  const allSeries = descriptorId === "energy" ? energyData.series : tableSeries;
  const selectedSeriesIds = resolveLiveChartSelectedSeriesIds(
    descriptor.selectedSeriesIds,
    allSeries,
    defaults.selectedSeriesIds,
  );
  const series = allSeries;
  const resource = descriptorId === "energy" ? energyData.resource : tableData.rows;
  const selectionHandlers = createLiveChartSelectionHandlers({ descriptorId, selection });
  const presentation = deriveChartPresentationState({
    content: descriptorId === "energy"
      ? energyData.resource.data?.rows.length === 0 ? "empty" : undefined
      : tableData.table?.rowCount === 0 ? "empty" : undefined,
    data: descriptorId === "energy" ? energyData.resource.data : tableData.table,
    error: resource.error,
    requestedRevision: resource.revision,
    status: tableData.unsupportedReason ? "unsupported" : resource.status,
    unsupportedReason: tableData.unsupportedReason,
    visibleRevision: descriptorId === "energy" ? energyData.resource.data?.revision ?? null : tableData.table?.revision ?? null,
  }, { latestKnownRevision: resource.revision, paused });
  const effectiveXAxisId = descriptorId === "energy" ? "t" : effectiveTableXAxisId;
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
    isFollowing: !paused,
    range: descriptorId === "energy" ? descriptor.range : tableData.range,
    xAxisId: effectiveXAxisId,
    xAxisOptions: descriptorId === "energy" ? [{ id: "t", label: "Time (s)" }] : liveChartXAxisOptions(tableData.columns.data ?? []),
    presentation,
    requestedExportRequest,
    series,
    selectedSeriesIds,
    title: liveChartPreset(descriptorId).title,
    xAxisLabel: effectiveXAxisId === "t" || effectiveXAxisId === "time"
      ? "Time"
      : effectiveXAxisId === "step"
        ? "Step"
        : effectiveXAxisId,
  };
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
      if (descriptorId !== "energy" && !isLiveChartTimeXAxisId(effectiveXAxisId)) return;
      liveChartsWorkspaceStore.setRange({ fromSI, toSI });
      preferences.setDescriptorRange(descriptorId, { mode: "fixed", fromSI, toSI });
    },
    onSeriesChange: (ids: string[]) => preferences.setDescriptorSelectedSeriesIds(descriptorId, ids),
    onRequestedExportHandled: () => {
      if (commandExportRequest && isCurrentExportCommand(commandExportRequest.requestId)) {
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

function applyLiveChartsCommand({
  action,
  descriptorId,
  preferences,
  tableXAxisId,
}: {
  action: Exclude<NonNullable<ReturnType<typeof liveChartsCommandRequests.getSnapshot>>, null>;
  descriptorId: string;
  preferences: LiveChartPreferencesActions;
  tableXAxisId: string;
}): void {
  if (action.kind === "export") return;
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
