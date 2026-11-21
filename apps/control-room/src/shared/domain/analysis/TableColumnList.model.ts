export interface AxisColumnUnit {
  column_id: string;
  unit: string;
}

const MAX_Y_AXIS_UNIT_GROUPS = 2;

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
