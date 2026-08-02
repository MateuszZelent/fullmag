"use client";

import { useMemo, useState } from "react";

import { liveChartsWorkspaceStore } from "@/kernel/workspace/liveChartsWorkspace";
import { useLiveChartPreferencesHydration } from "@/kernel/workspace/useLiveChartPreferencesHydration";
import { useLiveChartsWorkspaceSelector } from "@/kernel/workspace/useLiveChartsWorkspace";
import { deriveChartPresentationState } from "@/shared/analysis-charts/chartPresentationState";
import { buildScalarChartSeries } from "@/shared/domain/analysis/scalarTableChart";

import { useLiveEnergyData } from "./hooks/useLiveEnergyData";
import { useLiveTableData } from "./hooks/useLiveTableData";
import { liveChartPreset, type LiveChartPresetId } from "./liveChartsModel";

const DEFAULT_DESCRIPTOR = { liveMode: "following" as const, range: { mode: "follow" as const }, selectedSeriesIds: ["mx", "my", "mz"], targetPoints: 800, xAxisId: "step" };

export function useLiveChartsController() {
  const selectedDescriptorId = useLiveChartsWorkspaceSelector((state) => state.selectedDescriptorId);
  const descriptorId = (selectedDescriptorId ?? "magnetization") as LiveChartPresetId;
  const preferences = useLiveChartPreferencesHydration(descriptorId);
  const descriptor = preferences.descriptor ?? DEFAULT_DESCRIPTOR;
  const paused = descriptor.liveMode === "paused";
  const tableData = useLiveTableData({ active: descriptorId !== "energy", paused, range: descriptor.range, targetPoints: descriptor.targetPoints, xAxisId: descriptor.xAxisId });
  const energyData = useLiveEnergyData({ active: true, descriptorId, paused });
  const [fitRequest, setFitRequest] = useState(0);
  const tableSeries = useMemo(() => tableData.table ? buildScalarChartSeries({ ...tableData.table, valueAt: (rowIndex, columnIndex) => tableData.table!.values[rowIndex * tableData.table!.columnCount + columnIndex] }, {
    dataRevision: tableData.table.revision,
    status: tableData.rows.status === "error" ? "error" : "ready",
    tableId: "default",
    xAxisId: descriptor.xAxisId,
    yAxisIds: tableData.table.columns.filter((column) => column.column_id !== descriptor.xAxisId).map((column) => column.column_id),
  }) : [], [descriptor.xAxisId, tableData.rows.status, tableData.table]);
  const allSeries = descriptorId === "energy" ? energyData.series : tableSeries;
  const defaultIds = liveChartPreset(descriptorId).defaultSeriesIds;
  const selectedSeriesIds = preferences.isHydrated ? descriptor.selectedSeriesIds : defaultIds;
  const series = selectedSeriesIds.length === 0 ? allSeries : allSeries;
  const resource = descriptorId === "energy" ? energyData.resource : tableData.rows;
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
    onExport: (_format: "csv" | "tsv" | "png") => undefined,
    onFit: () => setFitRequest((value) => value + 1),
    onRangeSelected: (fromSI: number, toSI: number) => {
      liveChartsWorkspaceStore.setRange({ fromSI, toSI });
      preferences.setDescriptorRange(descriptorId, { mode: "fixed", fromSI, toSI });
    },
    onSeriesChange: (ids: string[]) => preferences.setDescriptorSelectedSeriesIds(descriptorId, ids),
    onToggleFollow: () => preferences.setDescriptorLiveMode(descriptorId, paused ? "following" : "paused"),
    presentation,
    series,
    selectedSeriesIds,
    title: liveChartPreset(descriptorId).title,
    xAxisLabel: descriptor.xAxisId,
  };
}
