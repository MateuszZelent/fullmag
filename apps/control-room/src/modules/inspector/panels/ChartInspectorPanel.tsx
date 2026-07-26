import { useCallback } from "react";


import { analysisPlotsWorkspaceStore } from "@/kernel/workspace/analysisPlotsWorkspace";
import { useAnalysisPlotsWorkspaceSelector } from "@/kernel/workspace/useAnalysisPlotsWorkspace";
import {
  nextYAxisIdsForToggle,
  sanitizeYAxisIdsForUnitLimit,
  TableColumnList,
} from "@/shared/domain/analysis/TableColumnList";
import { yAxisIdsAfterXAxisSelection } from "@/shared/domain/analysis/axisSelection";
import { QuickChartResourceView } from "@/shared/analysis-charts/QuickChartResourceView";

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

  const { availableColumns, xAxisId, yAxisIds } =
    useAnalysisPlotsWorkspaceSelector((state) => state);

  const toggleYAxis = useCallback(
    (columnId: string, enabled: boolean) => {
      const current = analysisPlotsWorkspaceStore.getSnapshot();
      analysisPlotsWorkspaceStore.setAxes(
        current.xAxisId,
        nextYAxisIdsForToggle(current.yAxisIds, columnId, enabled, {
          columns: current.availableColumns,
          xAxisId: current.xAxisId,
        }),
      );
    },
    [],
  );

  const setXAxisId = useCallback((columnId: string) => {
    const current = analysisPlotsWorkspaceStore.getSnapshot();
    analysisPlotsWorkspaceStore.setAxes(
      columnId,
      sanitizeYAxisIdsForUnitLimit(
        yAxisIdsAfterXAxisSelection(current.yAxisIds, columnId),
        current.availableColumns,
        columnId,
      ),
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
      <InspectorGroup title="Quick Chart">
        <QuickChartResourceView selection={selection} />
      </InspectorGroup>
      <InspectorGroup title="Columns">
        <TableColumnList
          columns={availableColumns.length > 0 ? availableColumns : null}
          onSelectXAxis={setXAxisId}
          onToggleYAxis={toggleYAxis}
          xAxisId={xAxisId}
          xAxisRadioName="fm-inspector-analysis-x-axis"
          yAxisIds={yAxisIds}
        />
      </InspectorGroup>
      <InspectorGroup title="Range">
        <FieldRow label="Mode" value="follow table cursor" />
        <FieldRow label="Visible cap" value="5000 rows" />
        <FieldRow
          label="Decimation"
          value="server target_points + bounded client window"
        />
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
