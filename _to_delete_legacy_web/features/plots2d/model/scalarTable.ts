/**
 * @module features/plots2d/model/scalarTable
 *
 * Columnar scalar data table — the core data structure for 2D plots.
 *
 * Instead of materializing row objects (`Record<string, number>[]`),
 * data is stored as typed arrays per column. This is directly
 * consumable by ECharts and avoids per-row GC pressure.
 */

import type { ScalarTable, ScalarTableDelta, ScalarSeriesMeta } from "./plot2dTypes";

// ─────────────────────────────────────────────────────────────────
// Construction
// ─────────────────────────────────────────────────────────────────

/**
 * Build a ScalarTable from a matrix-format backend response.
 *
 * This is the bridge from the current `ScalarWindow` format:
 * `{ columns: string[], rows: number[][], revision, total_rows }`
 */
export function scalarTableFromMatrix(input: {
  columns: string[];
  rows: number[][];
  revision: number;
  totalRows: number;
  meta?: Record<string, ScalarSeriesMeta>;
}): ScalarTable {
  const { columns, rows, revision, totalRows, meta } = input;
  const rowCount = rows.length;
  const data: Record<string, Float64Array> = {};

  for (let colIdx = 0; colIdx < columns.length; colIdx++) {
    const key = columns[colIdx];
    const arr = new Float64Array(rowCount);
    for (let rowIdx = 0; rowIdx < rowCount; rowIdx++) {
      const value = rows[rowIdx]?.[colIdx];
      arr[rowIdx] = typeof value === "number" && Number.isFinite(value) ? value : 0;
    }
    data[key] = arr;
  }

  return {
    columns,
    rowCount,
    data,
    metaByKey: meta ?? {},
    revision,
    totalRows,
  };
}

/**
 * Build a ScalarTable from legacy `ScalarRow[]` objects.
 *
 * Dynamically discovers columns from the first non-empty row.
 */
export function scalarTableFromRows(
  rows: Record<string, unknown>[],
  meta?: Record<string, ScalarSeriesMeta>,
): ScalarTable {
  if (rows.length === 0) {
    return emptyScalarTable();
  }

  // Discover columns from all rows (union of keys)
  const columnSet = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      columnSet.add(key);
    }
  }

  // Canonical order: step, time, solver_dt first, then alphabetical
  const priorityKeys = ["step", "time", "solver_dt"];
  const columns = [
    ...priorityKeys.filter((k) => columnSet.has(k)),
    ...[...columnSet]
      .filter((k) => !priorityKeys.includes(k))
      .sort(),
  ];

  const rowCount = rows.length;
  const data: Record<string, Float64Array> = {};

  for (const key of columns) {
    const arr = new Float64Array(rowCount);
    for (let i = 0; i < rowCount; i++) {
      const value = rows[i]?.[key];
      const num = typeof value === "number" ? value : Number(value);
      arr[i] = Number.isFinite(num) ? num : 0;
    }
    data[key] = arr;
  }

  return {
    columns,
    rowCount,
    data,
    metaByKey: meta ?? {},
    revision: 0,
    totalRows: rowCount,
  };
}

/**
 * Empty table sentinel.
 */
export function emptyScalarTable(): ScalarTable {
  return {
    columns: [],
    rowCount: 0,
    data: {},
    metaByKey: {},
    revision: 0,
    totalRows: 0,
  };
}

// ─────────────────────────────────────────────────────────────────
// Append / merge
// ─────────────────────────────────────────────────────────────────

/**
 * Append a delta to an existing table.
 *
 * The delta contains new rows for existing columns.
 * Deduplication: skips rows where `step` is <= the last step in the table.
 */
export function appendScalarDelta(
  table: ScalarTable,
  delta: ScalarTableDelta,
): ScalarTable {
  if (delta.appendRows.step == null || delta.appendRows.step.length === 0) {
    return { ...table, revision: delta.revision, totalRows: delta.totalRows };
  }

  // Determine the last step in the current table
  const stepCol = table.data.step;
  const lastStep = stepCol && stepCol.length > 0
    ? stepCol[stepCol.length - 1]
    : -1;

  // Find the first new row that's genuinely new
  const deltaSteps = delta.appendRows.step ?? [];
  let startIdx = 0;
  for (let i = 0; i < deltaSteps.length; i++) {
    if (deltaSteps[i] > lastStep) {
      startIdx = i;
      break;
    }
    if (i === deltaSteps.length - 1) {
      // All rows are duplicates
      return { ...table, revision: delta.revision, totalRows: delta.totalRows };
    }
  }

  const newRowCount = deltaSteps.length - startIdx;
  const totalRowCount = table.rowCount + newRowCount;

  // Merge columns
  const allColumns = new Set([...table.columns, ...delta.columns]);
  const columns = [...allColumns];
  const data: Record<string, Float64Array> = {};

  for (const key of columns) {
    const prevArr = table.data[key];
    const deltaArr = delta.appendRows[key];
    const merged = new Float64Array(totalRowCount);

    // Copy previous data
    if (prevArr) {
      merged.set(prevArr instanceof Float64Array ? prevArr : new Float64Array(prevArr));
    }

    // Copy new delta data
    if (deltaArr) {
      for (let i = 0; i < newRowCount; i++) {
        const value = deltaArr[startIdx + i];
        merged[table.rowCount + i] = Number.isFinite(value) ? value : 0;
      }
    }

    data[key] = merged;
  }

  return {
    columns,
    rowCount: totalRowCount,
    data,
    metaByKey: table.metaByKey,
    revision: delta.revision,
    totalRows: delta.totalRows,
  };
}

// ─────────────────────────────────────────────────────────────────
// Column access
// ─────────────────────────────────────────────────────────────────

/**
 * Get a column as a number array (for ECharts consumption).
 * Returns empty array if column doesn't exist.
 */
export function getColumn(table: ScalarTable, key: string): Float64Array | number[] {
  return table.data[key] ?? [];
}

/**
 * Check whether a column has at least one non-zero, finite value.
 */
export function columnHasData(table: ScalarTable, key: string): boolean {
  const col = table.data[key];
  if (!col || col.length === 0) return false;
  for (let i = 0; i < col.length; i++) {
    if (Number.isFinite(col[i]) && col[i] !== 0) return true;
  }
  return false;
}

/**
 * Get the last value in a column, or null if empty.
 */
export function lastColumnValue(table: ScalarTable, key: string): number | null {
  const col = table.data[key];
  if (!col || col.length === 0) return null;
  const val = col[col.length - 1];
  return Number.isFinite(val) ? val : null;
}

// ─────────────────────────────────────────────────────────────────
// Stats
// ─────────────────────────────────────────────────────────────────

export interface ColumnStats {
  min: number;
  max: number;
  mean: number;
  last: number;
  count: number;
}

export function computeColumnStats(table: ScalarTable, key: string): ColumnStats | null {
  const col = table.data[key];
  if (!col || col.length === 0) return null;

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let sum = 0;
  let count = 0;

  for (let i = 0; i < col.length; i++) {
    const v = col[i];
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    count++;
  }

  if (count === 0) return null;

  return {
    min,
    max,
    mean: sum / count,
    last: col[col.length - 1],
    count,
  };
}

// ─────────────────────────────────────────────────────────────────
// CSV export
// ─────────────────────────────────────────────────────────────────

/**
 * Serialize a ScalarTable to CSV.
 *
 * Dynamically discovers columns from the table — no hardcoded schema.
 * Missing values are empty (not "0").
 */
export function serializeScalarTableCsv(
  table: ScalarTable,
  opts?: {
    columns?: string[];
    includeAllColumns?: boolean;
  },
): string {
  const exportColumns = opts?.columns
    ?? (opts?.includeAllColumns ? table.columns : table.columns);

  // Header
  const lines: string[] = [exportColumns.join(",")];

  // Rows
  for (let rowIdx = 0; rowIdx < table.rowCount; rowIdx++) {
    const cells = exportColumns.map((key) => {
      const col = table.data[key];
      if (!col || rowIdx >= col.length) return "";
      const value = col[rowIdx];
      if (!Number.isFinite(value)) return "";
      return value.toExponential(15);
    });
    lines.push(cells.join(","));
  }

  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────
// Fingerprint (for render memoization)
// ─────────────────────────────────────────────────────────────────

export function scalarTableFingerprint(table: ScalarTable): string {
  if (table.rowCount === 0) return "0:-1";
  const stepCol = table.data.step;
  const timeCol = table.data.time;
  const lastStep = stepCol ? stepCol[stepCol.length - 1] : -1;
  const lastTime = timeCol ? timeCol[timeCol.length - 1] : -1;
  return `${table.rowCount}:${lastStep}:${lastTime?.toPrecision(12) ?? "-1"}:${table.revision}`;
}
