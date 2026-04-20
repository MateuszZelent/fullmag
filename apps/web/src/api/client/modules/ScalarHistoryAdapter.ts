/**
 * Adapters between the new ScalarWindow format (row-oriented with typed
 * ScalarRow) and the legacy row format used by chart / table consumers.
 */
import type { ScalarWindow, ScalarRow } from "../../types";

/**
 * Legacy row format expected by existing chart components.
 * Mirrors the old { step, t, ... } shape that predated ScalarRow.
 */
export interface LegacyScalarRow {
  step: number;
  t: number;
  [key: string]: number | string | null;
}

/**
 * Converts a typed ScalarRow into the legacy shape.
 * `iteration` → `step`, `sim_time` → `t`, everything else copied as-is.
 */
function tolegacyRow(row: ScalarRow): LegacyScalarRow {
  const { iteration, sim_time, ...rest } = row;
  return { step: iteration, t: sim_time, ...rest };
}

/**
 * Converts a new ScalarWindow to legacy LegacyScalarRow[].
 */
export function scalarWindowToRows(window: ScalarWindow): LegacyScalarRow[] {
  return window.rows.map(tolegacyRow);
}

/**
 * Merges an incremental ScalarWindow into existing accumulated rows,
 * deduplicating by step number.
 */
export function mergeScalarWindows(
  existing: LegacyScalarRow[],
  incoming: ScalarWindow,
): LegacyScalarRow[] {
  const newRows = scalarWindowToRows(incoming);
  if (existing.length === 0) return newRows;

  const lastExistingStep = existing[existing.length - 1].step;
  const deduplicated = newRows.filter((r) => r.step > lastExistingStep);
  return [...existing, ...deduplicated];
}
