import { tableColumnIdFromSeriesId } from "./chartSeriesSelection";

export interface LiveChartSeriesIdentity {
  id: string;
  quantity: string;
}

function resolveFrom(
  requestedIds: readonly string[],
  available: readonly LiveChartSeriesIdentity[],
): string[] {
  const ids = new Set<string>();
  for (const series of available) {
    const columnId = tableColumnIdFromSeriesId(series.id);
    if (requestedIds.some((requestedId) => {
      const requestedColumn = tableColumnIdFromSeriesId(requestedId);
      return requestedId === series.id || requestedId === series.quantity ||
        requestedColumn === series.quantity || requestedColumn === columnId;
    })) ids.add(series.id);
  }
  return [...ids];
}

/**
 * Resolves persisted chart selections against the series that actually
 * arrived from the current resource revision. An explicit empty selection is
 * intentional; only a non-empty selection with no matches is recovered from
 * the descriptor defaults.
 */
export function resolveLiveChartSelectedSeriesIds(
  persistedIds: readonly string[],
  available: readonly LiveChartSeriesIdentity[],
  defaultIds: readonly string[],
): string[] {
  if (persistedIds.length === 0) return [];
  const resolved = resolveFrom(persistedIds, available);
  return resolved.length > 0 ? resolved : resolveFrom(defaultIds, available);
}
