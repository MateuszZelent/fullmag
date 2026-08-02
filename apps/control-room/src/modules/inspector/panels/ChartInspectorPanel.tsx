import { useCallback } from "react";

import { useTableResource } from "@/kernel/resources/studyRuntimeResources";
import { chartRangePreferenceFromWorkspace } from "@/kernel/workspace/analysisChartPreferences";
import { analysisPlotsWorkspaceStore } from "@/kernel/workspace/analysisPlotsWorkspace";
import { useAnalysisChartPreferencesHydration } from "@/kernel/workspace/useAnalysisChartPreferencesHydration";
import { useAnalysisPlotsWorkspaceSelector } from "@/kernel/workspace/useAnalysisPlotsWorkspace";
import { sanitizeYAxisIdsForUnitLimit, TableColumnList } from "@/shared/domain/analysis/TableColumnList";
import { yAxisIdsAfterXAxisSelection } from "@/shared/domain/analysis/axisSelection";
import { ChartControlBar } from "@/shared/analysis-charts/ChartControlBar";
import {
  isTableChartSeriesId,
  replaceSelectedSeriesIdsInScope,
  tableChartSeriesId,
} from "@/shared/analysis-charts/chartSeriesSelection";
import { Button } from "@/shared/ui/Button";

import type { InspectorPanelProps } from "../inspectorTypes";
import { FieldRow } from "../primitives/FieldRow";
import { InspectorGroup } from "../primitives/InspectorGroup";

export function ChartInspectorPanel({ selection }: InspectorPanelProps) {
  const tableId =
    selection.ref?.type === "analysis-chart" ||
    selection.ref?.type === "analysis-chart-point"
      ? selection.ref.tableId
      : "default";
  const chartId =
    selection.ref?.type === "analysis-chart" ||
    selection.ref?.type === "analysis-chart-point"
      ? selection.ref.chartId
      : "default";
  const selectedPoint =
    selection.ref?.type === "analysis-chart-point" ? selection.ref : null;
  const descriptorId = `analysis:data-table:${tableId}`;
  const preferences = useAnalysisChartPreferencesHydration(descriptorId);
  const table = useTableResource(tableId);

  const { availableColumns, liveMode, range, rangeMode, targetPoints, xAxisId, selectedSeriesIds } =
    useAnalysisPlotsWorkspaceSelector((state) => state);

  const seriesIdForColumn = useCallback(
    (columnId: string) => tableChartSeriesId(tableId, xAxisId, columnId),
    [tableId, xAxisId],
  );

  const setSelectedSeriesIds = useCallback(
    (nextSelectedSeriesIds: string[]) => {
      const current = analysisPlotsWorkspaceStore.getSnapshot();
      const selectedColumnIds = current.availableColumns.flatMap((column) =>
        nextSelectedSeriesIds.includes(
          tableChartSeriesId(tableId, current.xAxisId, column.column_id),
        )
          ? [column.column_id]
          : [],
      );
      const sanitizedColumns = sanitizeYAxisIdsForUnitLimit(
        selectedColumnIds,
        current.availableColumns,
        current.xAxisId,
      );
      const sanitized = sanitizedColumns.map((columnId) =>
        tableChartSeriesId(tableId, current.xAxisId, columnId),
      );
      const merged = replaceSelectedSeriesIdsInScope(
        current.selectedSeriesIds,
        sanitized,
        isTableChartSeriesId,
      );
      analysisPlotsWorkspaceStore.setSelectedSeriesIds(merged);
      preferences.setDescriptorSelectedSeriesIds(descriptorId, sanitized);
    },
    [descriptorId, preferences, tableId],
  );

  const setXAxisId = useCallback((columnId: string) => {
    const current = analysisPlotsWorkspaceStore.getSnapshot();
    const selectedColumnIds = current.availableColumns.flatMap((column) =>
      current.selectedSeriesIds.includes(
        tableChartSeriesId(tableId, current.xAxisId, column.column_id),
      )
        ? [column.column_id]
        : [],
    );
    const nextSelectedColumnIds = sanitizeYAxisIdsForUnitLimit(
      yAxisIdsAfterXAxisSelection(selectedColumnIds, columnId),
      current.availableColumns,
      columnId,
    );
    const nextSelectedSeriesIds = nextSelectedColumnIds.map((selectedColumnId) =>
      tableChartSeriesId(tableId, columnId, selectedColumnId),
    );
    const merged = replaceSelectedSeriesIdsInScope(
      current.selectedSeriesIds,
      nextSelectedSeriesIds,
      isTableChartSeriesId,
    );
    analysisPlotsWorkspaceStore.setTableSelection(columnId, merged);
    preferences.setDescriptorXAxisId(descriptorId, columnId);
    preferences.setDescriptorSelectedSeriesIds(descriptorId, nextSelectedSeriesIds);
  }, [descriptorId, preferences, tableId]);

  return (
    <div className="fm-inspector-panel">
      <InspectorGroup title="Table Autosave">
        <FieldRow label="Chart" value={chartId} />
        <FieldRow label="Table" value={tableId} />
        <FieldRow
          label="Rows"
          value={table.data ? table.data.total_rows.toLocaleString() : "not available"}
        />
      </InspectorGroup>
      {selectedPoint ? (
        <InspectorGroup title="Selected Point">
          <FieldRow label="Series" value={selectedPoint.quantity} />
          <FieldRow label="Row" value={String(selectedPoint.rowIndex)} />
          <FieldRow label="X" value={formatInspectorNumber(selectedPoint.x)} />
          <FieldRow label="Y" value={formatInspectorNumber(selectedPoint.y)} />
        </InspectorGroup>
      ) : null}
      <InspectorGroup title="Columns">
        <TableColumnList
          columns={availableColumns.length > 0 ? availableColumns : null}
          onSelectXAxis={setXAxisId}
          onSelectedSeriesIdsChange={setSelectedSeriesIds}
          seriesIdForColumn={seriesIdForColumn}
          xAxisId={xAxisId}
          xAxisRadioName="fm-inspector-analysis-x-axis"
          selectedSeriesIds={selectedSeriesIds}
        />
      </InspectorGroup>
      <InspectorGroup title="Chart controls">
        <ChartControlBar
          fixedRangeAvailable={range !== null}
          liveMode={liveMode}
          onLiveModeToggle={() => {
            const next = liveMode === "following" ? "paused" : "following";
            analysisPlotsWorkspaceStore.setLiveMode(next);
            preferences.setDescriptorLiveMode(descriptorId, next);
          }}
          onFitView={() => analysisPlotsWorkspaceStore.requestFitView()}
          onRangeModeChange={(next) => {
            analysisPlotsWorkspaceStore.setRangeMode(next);
            preferences.setDescriptorRange(
              descriptorId,
              chartRangePreferenceFromWorkspace(
                next,
                analysisPlotsWorkspaceStore.getSnapshot().range,
              ),
            );
          }}
          onTargetPointsChange={(next) => {
            analysisPlotsWorkspaceStore.setTargetPoints(next);
            preferences.setDescriptorTargetPoints(descriptorId, next);
          }}
          rangeMode={range ? { mode: "fixed" } : rangeMode}
          targetPoints={targetPoints}
          timeRangeSupported={xAxisId === "t" || xAxisId === "time"}
        />
        {range ? (
          <Button
            aria-label="Clear zoom and return to the selected chart range"
            className="fm-analysis-plots__range-clear"
            onClick={() => {
              analysisPlotsWorkspaceStore.clearRange();
              preferences.setDescriptorRange(descriptorId, { mode: "follow" });
            }}
            size="sm"
            type="button"
            variant="secondary"
          >
            Clear zoom
          </Button>
        ) : null}
      </InspectorGroup>
    </div>
  );
}

function formatInspectorNumber(value: number): string {
  if (Math.abs(value) >= 1e4 || (value !== 0 && Math.abs(value) < 1e-3)) {
    return value.toExponential(6);
  }
  return Number.isInteger(value) ? String(value) : value.toPrecision(7);
}
