import { useCallback } from "react";

import {
  analysisPlotsWorkspaceStore,
} from "@/kernel/workspace/analysisPlotsWorkspace";
import { useAnalysisPlotsWorkspaceSelector } from "@/kernel/workspace/useAnalysisPlotsWorkspace";
import {
  nextYAxisIdsForToggle,
  sanitizeYAxisIdsForUnitLimit,
  TableColumnList,
} from "@/shared/domain/analysis/TableColumnList";
import { yAxisIdsAfterXAxisSelection } from "@/shared/domain/analysis/axisSelection";

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

  const { tableState, xAxisId, yAxisIds } = useAnalysisPlotsWorkspaceSelector(
    (state) => state,
  );

  const toggleYAxis = useCallback(
    (columnId: string, enabled: boolean) => {
      const current = analysisPlotsWorkspaceStore.getSnapshot();
      const columns = current.tableState.visibleTable?.columns;
      analysisPlotsWorkspaceStore.setAxes(
        current.xAxisId,
        nextYAxisIdsForToggle(current.yAxisIds, columnId, enabled, {
          columns,
          xAxisId: current.xAxisId,
        }),
      );
    },
    [],
  );

  const setXAxisId = useCallback((columnId: string) => {
    const current = analysisPlotsWorkspaceStore.getSnapshot();
    const columns = current.tableState.visibleTable?.columns;
    analysisPlotsWorkspaceStore.setAxes(
      columnId,
      columns
        ? sanitizeYAxisIdsForUnitLimit(
            yAxisIdsAfterXAxisSelection(current.yAxisIds, columnId),
            columns,
            columnId,
          )
        : yAxisIdsAfterXAxisSelection(current.yAxisIds, columnId),
    );
  }, []);

  return (
    <div className="fm-inspector-panel">
      <InspectorGroup title="Table Autosave">
        <FieldRow label="Chart" value={chartId} />
        <FieldRow label="Table" value={tableId} />
        <FieldRow label="Cadence" value="study.table_autosave(t_sampl)" />
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
          onSelectXAxis={setXAxisId}
          onToggleYAxis={toggleYAxis}
          table={tableState.visibleTable}
          xAxisId={xAxisId}
          xAxisRadioName="fm-inspector-analysis-x-axis"
          yAxisIds={yAxisIds}
        />
      </InspectorGroup>
      <InspectorGroup title="Range">
        <FieldRow label="Mode" value="follow table cursor" />
        <FieldRow label="Visible cap" value="5000 rows" />
        <FieldRow label="Decimation" value="server target_points + bounded client window" />
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
