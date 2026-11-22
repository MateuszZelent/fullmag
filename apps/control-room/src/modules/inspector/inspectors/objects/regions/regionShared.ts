import type { JsonValue } from "@/kernel/api/apiTypes";
import type { ObjectVisualizationSnapshot } from "@/kernel/visualization/ObjectVisualizationController";
import { formatLengthAuto } from "../../../panels/model-roots/SpecInspectorHost";

export {
  extractSelectionTarget,
  resolveCanonicalRegionMeshLane,
  type CanonicalRegionMeshLane,
  type RegionFieldProfileMode,
} from "../../../panels/region/regionInspectorHelpers";

export const EMPTY_VISUALIZATION_SNAPSHOT: ObjectVisualizationSnapshot = {
  defaults: {},
  overrides: {},
  version: 0,
};

export function formatVectorSpanAuto(vec: readonly [number, number, number]): string {
  return `${formatLengthAuto(vec[0])} \u00d7 ${formatLengthAuto(vec[1])} \u00d7 ${formatLengthAuto(vec[2])}`;
}

export function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

/**
 * Computes strictly descending integer priorities for an ordered precedence stack
 * (index 0 = highest precedence, matching `crates/fullmag-plan/src/region_conflict.rs`).
 * Preserves existing distinct priority values (e.g. `[5, 1]` -> `[5, 1]`) and breaks
 * equal-priority ties monotonically (`[0, 0]` -> `[1, 0]`, `[5, 5, 1]` -> `[6, 5, 1]`).
 */
export function assignDescendingPrecedencePriorities(
  currentPriorities: readonly number[],
): number[] {
  const n = currentPriorities.length;
  if (n === 0) return [];
  const sortedDesc = [...currentPriorities]
    .map((p) => (Number.isFinite(p) ? Math.trunc(p) : 0))
    .sort((a, b) => b - a);
  const assigned = new Array<number>(n);
  assigned[n - 1] = sortedDesc[n - 1]!;
  for (let i = n - 2; i >= 0; i--) {
    assigned[i] = Math.max(sortedDesc[i]!, assigned[i + 1]! + 1);
  }
  return assigned;
}
