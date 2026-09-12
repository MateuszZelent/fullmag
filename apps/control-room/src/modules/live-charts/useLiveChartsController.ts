"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

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
  const [localExportRequest, setLocalExportRequest] = useState<LiveChartsExportRequest | null>(null);
  const localExportSequenceRef = useRef(0);
  const fitRequest = commandFitRequest + localFitRequest;
  const requestedExportRequest: LiveChartsExportRequest | null = commandAction?.kind === "export"
    ? {
        format: commandAction.format,
        requestId: commandAction.requestId ?? `live-charts-command-export-${commandAction.format}`,
      }
    : localExportRequest;
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
        const nextRange = descriptorId === "energy"
          ? commandAction.range
          : normalizeLiveChartRangeForXAxis(commandAction.range, tableData.xAxisId);
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
    if (commandAction.kind === "set-preset") {
      liveChartsWorkspaceStore.setSelectedDescriptorId(commandAction.descriptorId);
      liveChartsCommandRequests.complete();
    }
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
  return {
    descriptorId,
    fitRequest,
    isFollowing: !paused,
    onDescriptorChange: (next: LiveChartPresetId) => liveChartsWorkspaceStore.setSelectedDescriptorId(next),
    onExport: (format: "csv" | "tsv" | "png") => setLocalExportRequest({
      format,
      requestId: `live-charts-local-export-${++localExportSequenceRef.current}`,
    }),
    onFit: () => setLocalFitRequest((value) => value + 1),
    ...selectionHandlers,
    onRangeSelected: (fromSI: number, toSI: number) => {
      if (descriptorId !== "energy" && !isLiveChartTimeXAxisId(effectiveXAxisId)) return;
      liveChartsWorkspaceStore.setRange({ fromSI, toSI });
      preferences.setDescriptorRange(descriptorId, { mode: "fixed", fromSI, toSI });
    },
    onSeriesChange: (ids: string[]) => preferences.setDescriptorSelectedSeriesIds(descriptorId, ids),
    onRequestedExportHandled: () => {
      setLocalExportRequest(null);
      liveChartsCommandRequests.complete();
    },
    onRequestedExportFailed: () => {
      setLocalExportRequest(null);
      liveChartsCommandRequests.fail();
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
    onRangeChange: descriptorId === "energy" || !isLiveChartServerXAxisId(effectiveXAxisId) ? undefined : (range: ChartRangePreference) => {
      liveChartsWorkspaceStore.clearRange();
      preferences.setDescriptorRange(descriptorId, normalizeLiveChartRangeForXAxis(range, effectiveXAxisId));
      setLocalFitRequest((value) => value + 1);
    },
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
