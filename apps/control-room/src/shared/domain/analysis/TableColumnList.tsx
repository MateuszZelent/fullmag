export interface AxisColumnUnit {
  column_id: string;
  unit: string;
}

export interface AxisColumnDescriptor extends AxisColumnUnit {
  component?: string | null;
  dimension?: string;
  label: string;
  quantity_id?: string;
  reduction?: string | null;
  scope?: string;
}

const MAX_Y_AXIS_UNIT_GROUPS = 2;
const THIRD_UNIT_DISABLED_REASON = "Select at most two Y-axis unit groups";

export function TableColumnList({
  columns,
  onSelectXAxis,
  onSelectedSeriesIdsChange,
  seriesIdForColumn,
  xAxisId,
  xAxisRadioName,
  showQuantityId = false,
  selectedSeriesIds,
}: {
  columns: readonly AxisColumnDescriptor[] | null;
  onSelectXAxis: (id: string) => void;
  onSelectedSeriesIdsChange: (selectedSeriesIds: string[]) => void;
  seriesIdForColumn: (columnId: string) => string;
  xAxisId: string;
  xAxisRadioName: string;
  showQuantityId?: boolean;
  selectedSeriesIds: readonly string[];
}) {
  if (!columns) {
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
      {columns.map((column) => {
        const seriesId = seriesIdForColumn(column.column_id);
        const yAxisChecked = selectedSeriesIds.includes(seriesId);
        const selectedColumnIds = columns.flatMap((candidate) =>
          selectedSeriesIds.includes(seriesIdForColumn(candidate.column_id))
            ? [candidate.column_id]
            : [],
        );
        const nextCheckedIds = nextYAxisIdsForToggle(
          selectedColumnIds,
          column.column_id,
          true,
          { columns, xAxisId },
        );
        const exceedsUnitLimit =
          !yAxisChecked && !nextCheckedIds.includes(column.column_id);
        const yAxisDisabled =
          xAxisId === column.column_id ||
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
              onChange={(event) =>
                onSelectedSeriesIdsChange(
                  toggleSelectedSeriesId(
                    selectedSeriesIds,
                    seriesId,
                    event.target.checked,
                  ),
                )
              }
            />
            <span className="fm-analysis-plots__column-label">
              {column.label}
              {showQuantityId ? (
                <span className="fm-analysis-plots__column-id">{column.column_id}</span>
              ) : null}
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
import { toggleSelectedSeriesId } from "@/shared/analysis-charts/chartSeriesSelection";
