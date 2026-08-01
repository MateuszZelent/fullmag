import type { AxisColumnDescriptor } from "./TableColumnList";

export const ANALYSIS_CHART_COLUMNS = Object.freeze([
  "step", "t", "mx", "my", "mz", "e_total", "max_torque_Apm",
  "pseudo_time_s", "active_runtime_s",
] as const);

const MAX_CHART_ROWS = 5_000;
const MIN_TARGET_POINTS = 160;
const OPTIONAL_RUNTIME_COLUMNS: Readonly<Record<string, AxisColumnDescriptor>> = {
  active_runtime_s: { column_id: "active_runtime_s", label: "active runtime", unit: "s" },
  pseudo_time_s: { column_id: "pseudo_time_s", label: "pseudo time", unit: "s" },
};

export function analysisColumnDescriptorsForQuery(
  columns: readonly AxisColumnDescriptor[],
  queryColumns: readonly string[],
): AxisColumnDescriptor[] {
  const byId = new Map(columns.map((column) => [column.column_id, column]));
  return queryColumns.flatMap((columnId) => {
    const column = byId.get(columnId) ?? OPTIONAL_RUNTIME_COLUMNS[columnId];
    return column
      ? [{ column_id: column.column_id, label: column.label || column.column_id, unit: column.unit }]
      : [];
  });
}

export interface ChartDataPlan {
  columns: readonly string[];
  decimation: "minmax_lttb";
  fromRow?: number;
  fromT?: number;
  includeTail: boolean;
  key: string;
  limit: number;
  resourceKey: string;
  resourceRevision: number;
  targetPoints: number;
  toRow?: number;
  toT?: number;
}

export interface ChartTableWindow {
  columnCount: number;
  columns: readonly AxisColumnDescriptor[];
  cursorEnd: number;
  cursorStart: number;
  resyncRequired: boolean;
  revision: number;
  rowCount: number;
  schemaRevision: number;
  tableId: string;
  totalRows: number;
  values: Float64Array;
}

export interface ChartBinaryTableWindow {
  columnCount: number;
  cursorEnd: number;
  cursorStart: number;
  resyncRequired: boolean;
  revision: number;
  rowCount: number;
  schemaRevision: number;
  totalRows: number;
  values: Float64Array;
}

export function buildSharedAnalysisTableQuery({
  columns,
  cursor,
  fromT,
  toT,
}: {
  columns: readonly string[];
  cursor?: number;
  fromT?: number;
  toT?: number;
}) {
  const hasRange = fromT !== undefined || toT !== undefined;
  return {
    columns,
    cursor: hasRange ? undefined : cursor,
    decimation: "minmax_lttb" as const,
    fromT,
    includeTail: !hasRange,
    limit: MAX_CHART_ROWS,
    targetPoints: 1_600,
    toT,
  };
}

export function buildChartDataPlan({
  columns,
  fromRow,
  fromT,
  limit = MAX_CHART_ROWS,
  resourceKey,
  resourceRevision,
  targetPoints = 1_600,
  toRow,
  toT,
}: {
  columns: readonly string[];
  fromRow?: number;
  fromT?: number;
  limit?: number;
  resourceKey: string;
  resourceRevision: number;
  targetPoints?: number;
  toRow?: number;
  toT?: number;
}): ChartDataPlan {
  if (!resourceKey || !Number.isSafeInteger(resourceRevision)) {
    throw new Error("ChartDataPlan requires revisioned resource identity.");
  }
  const boundedLimit = clampInteger(limit, 1, MAX_CHART_ROWS);
  const boundedTarget = clampInteger(
    targetPoints,
    MIN_TARGET_POINTS,
    MAX_CHART_ROWS,
  );
  const includeTail =
    fromRow === undefined &&
    fromT === undefined &&
    toRow === undefined &&
    toT === undefined;
  const queryIdentity = JSON.stringify({
    columns,
    fromRow,
    fromT,
    includeTail,
    limit: boundedLimit,
    targetPoints: boundedTarget,
    toRow,
    toT,
  });
  return {
    columns: [...columns],
    decimation: "minmax_lttb",
    fromRow,
    fromT,
    includeTail,
    key: `${resourceKey}@${resourceRevision}:${queryIdentity}`,
    limit: boundedLimit,
    resourceKey,
    resourceRevision,
    targetPoints: boundedTarget,
    toRow,
    toT,
  };
}

export function chartTableWindowFromBinary({
  columns,
  decoded,
  tableId,
}: {
  columns: readonly AxisColumnDescriptor[];
  decoded: ChartBinaryTableWindow;
  tableId: string;
}): ChartTableWindow {
  if (
    decoded.columnCount !== columns.length ||
    decoded.values.length !== decoded.rowCount * decoded.columnCount
  ) {
    throw new Error(
      `Invalid chart table binary shape: rows=${decoded.rowCount}, columns=${decoded.columnCount}, values=${decoded.values.length}.`,
    );
  }
  const window: ChartTableWindow = {
    ...decoded,
    columns,
    tableId,
  };
  return decoded.rowCount > MAX_CHART_ROWS
    ? trimChartTableWindow(window)
    : window;
}

export function chartTableWindowValue(
  window: ChartTableWindow,
  rowIndex: number,
  columnIndex: number,
): number | undefined {
  if (
    rowIndex < 0 ||
    columnIndex < 0 ||
    rowIndex >= window.rowCount ||
    columnIndex >= window.columnCount
  ) {
    return undefined;
  }
  return window.values[rowIndex * window.columnCount + columnIndex];
}

export function mergeChartTableWindows(
  current: ChartTableWindow | null,
  incoming: ChartTableWindow,
): ChartTableWindow {
  if (
    !current ||
    incoming.resyncRequired ||
    incoming.cursorStart <= 1 ||
    !sameColumns(current, incoming)
  ) {
    return trimChartTableWindow(incoming);
  }
  const overlap = Math.max(0, current.cursorEnd - incoming.cursorStart + 1);
  const appendedRows = Math.max(0, incoming.rowCount - overlap);
  if (appendedRows === 0) return current;

  const combinedRows = current.rowCount + appendedRows;
  const keptRows = Math.min(combinedRows, MAX_CHART_ROWS);
  const droppedRows = combinedRows - keptRows;
  const values = new Float64Array(keptRows * current.columnCount);
  const currentRowsToKeep = Math.max(0, current.rowCount - droppedRows);
  if (currentRowsToKeep > 0) {
    const currentStart = droppedRows * current.columnCount;
    values.set(
      current.values.subarray(
        currentStart,
        currentStart + currentRowsToKeep * current.columnCount,
      ),
    );
  }
  const incomingStart = overlap * incoming.columnCount;
  values.set(
    incoming.values.subarray(incomingStart),
    currentRowsToKeep * current.columnCount,
  );

  return {
    ...incoming,
    columns: current.columns,
    cursorStart: current.cursorStart + droppedRows,
    rowCount: keptRows,
    values,
  };
}

function trimChartTableWindow(window: ChartTableWindow): ChartTableWindow {
  if (window.rowCount <= MAX_CHART_ROWS) return window;
  const droppedRows = window.rowCount - MAX_CHART_ROWS;
  return {
    ...window,
    cursorStart: window.cursorStart + droppedRows,
    rowCount: MAX_CHART_ROWS,
    values: window.values.slice(droppedRows * window.columnCount),
  };
}

function sameColumns(
  left: ChartTableWindow,
  right: ChartTableWindow,
): boolean {
  return (
    left.columnCount === right.columnCount &&
    left.columns.every(
      (column, index) =>
        column.column_id === right.columns[index]?.column_id,
    )
  );
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}
