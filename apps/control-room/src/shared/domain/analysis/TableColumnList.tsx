import { useId } from "react";

export interface AxisColumnDescriptor extends AxisColumnUnit {
  component?: string | null;
  dimension?: string;
  label: string;
  quantity_id?: string;
  reduction?: string | null;
  scope?: string;
}
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
  const controlId = useId();
  if (!columns) {
    return <div className="fm-analysis-plots__empty">No table schema</div>;
  }
  const selectedSeries = new Set(selectedSeriesIds);
  const selectedColumnIds = columns.flatMap((column) =>
    selectedSeries.has(seriesIdForColumn(column.column_id)) ? [column.column_id] : [],
  );
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
        const yAxisChecked = selectedSeries.has(seriesId);
        const xControlId = `${controlId}-x-${column.column_id}`;
        const yControlId = `${controlId}-y-${column.column_id}`;
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
          <div
            key={column.column_id}
            className="fm-analysis-plots__column-row"
          >
            <input
              checked={xAxisId === column.column_id}
              className="fm-analysis-plots__radio"
              id={xControlId}
              name={xAxisRadioName}
              type="radio"
              onChange={() => onSelectXAxis(column.column_id)}
            />
            <input
              checked={yAxisChecked}
              className="fm-analysis-plots__checkbox"
              disabled={yAxisDisabled}
              id={yControlId}
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
            <label className="sr-only" htmlFor={yControlId}>Y axis: {column.label}</label>
            <label className="fm-analysis-plots__column-label" htmlFor={xControlId}>
              <span className="sr-only">X axis: </span>
              {column.label}
              {showQuantityId ? (
                <span className="fm-analysis-plots__column-id">{column.column_id}</span>
              ) : null}
            </label>
            <span className="fm-analysis-plots__column-unit">{column.unit}</span>
          </div>
        );
      })}
    </div>
  );
}
import { toggleSelectedSeriesId } from "@/shared/analysis-charts/chartSeriesSelection";
import { type AxisColumnUnit, nextYAxisIdsForToggle } from "./TableColumnList.model";
