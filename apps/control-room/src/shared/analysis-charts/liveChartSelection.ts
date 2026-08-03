import { tableColumnIdFromSeriesId } from "./chartSeriesSelection";

export interface LiveChartSeriesIdentity {
  id: string;
  quantity: string;
}

function resolveFrom(
  requestedIds: readonly string[],
  available: readonly LiveChartSeriesIdentity[],
): string[] {
  return available
    .filter((series) => requestedIds.some((requestedId) => (
      requestedId === series.id ||
      requestedId === series.quantity ||
      tableColumnIdFromSeriesId(requestedId) === series.quantity ||
      tableColumnIdFromSeriesId(requestedId) === tableColumnIdFromSeriesId(series.id)
    )))
    .map((series) => series.id)
    .filter((id, index, ids) => ids.indexOf(id) === index);
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
