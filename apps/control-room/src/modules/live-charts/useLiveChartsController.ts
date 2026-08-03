"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { liveChartsWorkspaceStore } from "@/kernel/workspace/liveChartsWorkspace";
import { useLiveChartPreferencesHydration } from "@/kernel/workspace/useLiveChartPreferencesHydration";
import { liveChartPreferencesStore } from "@/kernel/workspace/liveChartPreferences";
import { useLiveChartsWorkspaceSelector } from "@/kernel/workspace/useLiveChartsWorkspace";
import type { SelectionController } from "@/kernel/selection/SelectionController";
import type { LayoutController } from "@/kernel/layout/LayoutController";
import { deriveChartPresentationState } from "@/shared/analysis-charts/chartPresentationState";
import { buildScalarChartSeries } from "@/shared/domain/analysis/scalarTableChart";

import { useLiveEnergyData } from "./hooks/useLiveEnergyData";
import { useLiveTableData } from "./hooks/useLiveTableData";
import { liveChartDescriptorDefaults, liveChartPreset, type LiveChartPresetId } from "./liveChartsModel";
import { liveChartsCommandRequests } from "./liveChartsCommandRequests";
import { resolveLiveChartSelectedSeriesIds } from "./liveChartsSelection";

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
  const [localRequestedExportFormat, setLocalRequestedExportFormat] = useState<"csv" | "tsv" | "png" | null>(null);
  const fitRequest = commandFitRequest + localFitRequest;
  const requestedExportFormat = commandAction?.kind === "export"
    ? commandAction.format
    : localRequestedExportFormat;
  useEffect(() => {
    if (!preferences.isHydrated || preferences.descriptor) return;
    liveChartPreferencesStore.updateDescriptor(descriptorId, () => defaults);
  }, [defaults, descriptorId, preferences.descriptor, preferences.isHydrated]);
  useEffect(() => {
    if (!commandAction) return;
    if (commandAction.kind === "fit") {
      liveChartsCommandRequests.complete();
      return;
    }
    if (commandAction.kind === "set-live-mode") {
      if (!commandAction.descriptorId || commandAction.descriptorId === descriptorId) {
        preferences.setDescriptorLiveMode(descriptorId, commandAction.liveMode);
      }
      liveChartsCommandRequests.complete();
      return;
    }
    if (commandAction.kind === "set-selected-series") {
      if (commandAction.descriptorId === descriptorId) {
        preferences.setDescriptorSelectedSeriesIds(descriptorId, commandAction.selectedSeriesIds);
      }
      liveChartsCommandRequests.complete();
      return;
    }
    if (commandAction.kind === "set-range") {
      if (commandAction.descriptorId === descriptorId) {
        if (commandAction.range.mode === "fixed") {
          liveChartsWorkspaceStore.setRange({ fromSI: commandAction.range.fromSI, toSI: commandAction.range.toSI });
        } else {
          liveChartsWorkspaceStore.clearRange();
        }
        preferences.setDescriptorRange(descriptorId, commandAction.range);
      }
      liveChartsCommandRequests.complete();
      return;
    }
    if (commandAction.kind === "set-preset") {
      liveChartsWorkspaceStore.setSelectedDescriptorId(commandAction.descriptorId);
      liveChartsCommandRequests.complete();
    }
  }, [commandAction, descriptorId, preferences]);
  const tableSeries = useMemo(() => tableData.table ? buildScalarChartSeries({ ...tableData.table, valueAt: (rowIndex, columnIndex) => tableData.table!.values[rowIndex * tableData.table!.columnCount + columnIndex] }, {
    dataRevision: tableData.table.revision,
    status: tableData.rows.status === "error" ? "error" : "ready",
    tableId: "default",
    xAxisId: descriptor.xAxisId,
    yAxisIds: tableData.table.columns.filter((column) => column.column_id !== descriptor.xAxisId).map((column) => column.column_id),
  }) : [], [descriptor.xAxisId, tableData.rows.status, tableData.table]);
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
    content: tableData.table && tableData.table.rowCount === 0 ? "empty" : undefined,
    data: descriptorId === "energy" ? energyData.resource.data : tableData.table,
    error: resource.error,
    requestedRevision: resource.revision,
    status: tableData.unsupportedReason ? "unsupported" : resource.status,
    unsupportedReason: tableData.unsupportedReason,
    visibleRevision: descriptorId === "energy" ? energyData.resource.data?.revision ?? null : tableData.table?.revision ?? null,
  }, { latestKnownRevision: resource.revision, paused });
  return {
    descriptorId,
    fitRequest,
    isFollowing: !paused,
    onDescriptorChange: (next: LiveChartPresetId) => liveChartsWorkspaceStore.setSelectedDescriptorId(next),
    onExport: (format: "csv" | "tsv" | "png") => setLocalRequestedExportFormat(format),
    onFit: () => setLocalFitRequest((value) => value + 1),
    ...selectionHandlers,
    onRangeSelected: (fromSI: number, toSI: number) => {
      liveChartsWorkspaceStore.setRange({ fromSI, toSI });
      preferences.setDescriptorRange(descriptorId, { mode: "fixed", fromSI, toSI });
    },
    onSeriesChange: (ids: string[]) => preferences.setDescriptorSelectedSeriesIds(descriptorId, ids),
    onRequestedExportHandled: () => {
      setLocalRequestedExportFormat(null);
      liveChartsCommandRequests.complete();
    },
    onToggleFollow: () => preferences.setDescriptorLiveMode(descriptorId, paused ? "following" : "paused"),
    presentation,
    requestedExportFormat,
    series,
    selectedSeriesIds,
    title: liveChartPreset(descriptorId).title,
    xAxisLabel: descriptor.xAxisId,
  };
}
