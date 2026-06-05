import type { TableRowsResource } from "@/kernel/api/apiTypes";

export interface AxisColumnUnit {
  column_id: string;
  unit: string;
}

const MAX_Y_AXIS_UNIT_GROUPS = 2;
const THIRD_UNIT_DISABLED_REASON = "Select at most two Y-axis unit groups";

export function TableColumnList({
  onSelectXAxis,
  onToggleYAxis,
  table,
  xAxisId,
  xAxisRadioName,
  yAxisIds,
}: {
  onSelectXAxis: (id: string) => void;
  onToggleYAxis: (id: string, enabled: boolean) => void;
  table: TableRowsResource | null;
  xAxisId: string;
  xAxisRadioName: string;
  yAxisIds: string[];
}) {
  if (!table) {
    return <div className="fm-analysis-plots__empty">No table schema</div>;
  }
  return (
    <div className="fm-analysis-plots__columns">
      <div className="fm-analysis-plots__column-header">
        <span title="X Axis">X</span>
        <span title="Y Axis">Y</span>
        <span>Name</span>
        <span>Unit</span>
      </div>
      {table.columns.map((column) => {
        const yAxisChecked = yAxisIds.includes(column.column_id);
        const nextCheckedIds = nextYAxisIdsForToggle(
          yAxisIds,
          column.column_id,
          true,
          { columns: table.columns, xAxisId },
        );
        const exceedsUnitLimit =
          !yAxisChecked && !nextCheckedIds.includes(column.column_id);
        const yAxisDisabled =
          xAxisId === column.column_id ||
          (yAxisChecked && yAxisIds.length <= 1) ||
          exceedsUnitLimit;
        const checkboxTitle = exceedsUnitLimit
          ? THIRD_UNIT_DISABLED_REASON
          : undefined;
        return (
          <label
            key={column.column_id}
            className="fm-analysis-plots__column-row"
          >
            <input
              checked={xAxisId === column.column_id}
              className="fm-analysis-plots__radio"
              name={xAxisRadioName}
              type="radio"
              onChange={() => onSelectXAxis(column.column_id)}
            />
            <input
              checked={yAxisChecked}
              className="fm-analysis-plots__checkbox"
              disabled={yAxisDisabled}
              title={checkboxTitle}
              type="checkbox"
              onChange={(e) =>
                onToggleYAxis(column.column_id, e.target.checked)
              }
            />
            <span className="fm-analysis-plots__column-label">
              {column.label}
            </span>
            <span className="fm-analysis-plots__column-unit">{column.unit}</span>
          </label>
        );
      })}
    </div>
  );
}

export function nextYAxisIdsForToggle(
  yAxisIds: readonly string[],
  columnId: string,
  enabled: boolean,
  options: {
    columns?: readonly AxisColumnUnit[];
    xAxisId?: string;
  } = {},
): string[] {
  if (enabled) {
    const nextIds = yAxisIds.includes(columnId)
      ? [...yAxisIds]
      : [...yAxisIds, columnId];
    return options.columns
      ? sanitizeYAxisIdsForUnitLimit(
          nextIds,
          options.columns,
          options.xAxisId,
        )
      : nextIds;
  }
  if (!yAxisIds.includes(columnId)) return [...yAxisIds];
  if (yAxisIds.length <= 1) return [...yAxisIds];
  return yAxisIds.filter((id) => id !== columnId);
}

export function sanitizeYAxisIdsForUnitLimit(
  yAxisIds: readonly string[],
  columns: readonly AxisColumnUnit[],
  xAxisId?: string,
): string[] {
  const unitByColumnId = new Map(
    columns.map((column) => [column.column_id, column.unit] as const),
  );
  const selectedUnitGroups = new Set<string>();
  const sanitized: string[] = [];
  for (const columnId of yAxisIds) {
    if (columnId === xAxisId) continue;
    const unit = unitByColumnId.get(columnId);
    if (unit === undefined) continue;
    if (
      !selectedUnitGroups.has(unit) &&
      selectedUnitGroups.size >= MAX_Y_AXIS_UNIT_GROUPS
    ) {
      continue;
    }
    selectedUnitGroups.add(unit);
    sanitized.push(columnId);
  }
  return sanitized;
}
