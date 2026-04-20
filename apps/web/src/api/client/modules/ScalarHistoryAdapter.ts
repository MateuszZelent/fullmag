/**
 * Adapters between the columnar ScalarWindow format and row-shaped frontend consumers.
 */

import type { ScalarWindow } from "../../generated/openapi-types";

export interface LegacyScalarRow {
  step: number;
  t: number;
  [key: string]: number | string | null;
}

function scalarRowFromWindow(
  window: ScalarWindow,
  values: number[],
): LegacyScalarRow {
  const row: LegacyScalarRow = {
    step: 0,
    t: 0,
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
      continue;
    }
    row[column] = value;
  }

  return row;
}

export function scalarWindowToRows(window: ScalarWindow): LegacyScalarRow[] {
  return window.rows.map((values) => scalarRowFromWindow(window, values));
}

export function mergeScalarWindows(
  existing: LegacyScalarRow[],
  incoming: ScalarWindow,
): LegacyScalarRow[] {
  const newRows = scalarWindowToRows(incoming);
  if (existing.length === 0) {
    return newRows;
  }

  const lastExistingStep = existing[existing.length - 1].step;
  const deduplicated = newRows.filter((row) => row.step > lastExistingStep);
  return [...existing, ...deduplicated];
}
