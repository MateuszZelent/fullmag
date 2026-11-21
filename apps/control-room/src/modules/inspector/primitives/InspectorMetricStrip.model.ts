import type { ReactNode } from "react";

const UNKNOWN_VALUES = new Set(["", "unknown", "n/a", "-", "—"]);

/**
 * A fact the Inspector cannot state is omitted instead of shown as
 * "unknown" (specs/frontend-v2/13 §1a, slot 3).
 */
export function isKnownMetricValue(value: ReactNode): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === "string") {
    return !UNKNOWN_VALUES.has(value.trim().toLowerCase());
  }
  return true;
}
