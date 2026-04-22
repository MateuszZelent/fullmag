/**
 * Adapters between the columnar ScalarWindow format and row-shaped frontend consumers.
 */

import type { ScalarWindow } from "../../generated/openapi-types";

export interface ScalarHistoryRow {
  step: number;
  t: number;
  time: number | null;
  [key: string]: number | string | null;
}

function scalarRowFromWindow(
  window: ScalarWindow,
  values: number[],
): ScalarHistoryRow {
  const row: ScalarHistoryRow = {
    step: 0,
    t: 0,
    time: null,
  };

  for (let i = 0; i < window.columns.length; i++) {
    const column = window.columns[i];
    const value = values[i] ?? 0;
    if (column === "step") {
      row.step = value;
      continue;
    }
    if (column === "time") {
      row.t = value;
      row.time = value;
      continue;
    }
    row[column] = value;
  }

  return row;
}

export function scalarWindowToRows(window: ScalarWindow): ScalarHistoryRow[] {
  return window.rows.map((values) => scalarRowFromWindow(window, values));
}

export function mergeScalarWindows(
  existing: ScalarHistoryRow[],
  incoming: ScalarWindow,
): ScalarHistoryRow[] {
  const newRows = scalarWindowToRows(incoming);
  if (existing.length === 0) {
    return newRows;
  }

  const lastExistingStep = existing[existing.length - 1].step;
  const deduplicated = newRows.filter((row) => row.step > lastExistingStep);
  return [...existing, ...deduplicated];
}
