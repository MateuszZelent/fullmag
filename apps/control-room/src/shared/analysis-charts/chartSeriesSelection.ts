export function sanitizeSelectedSeriesIds(
  selectedSeriesIds: readonly string[],
  availableSeriesIds: readonly string[],
): string[] {
  const available = new Set(availableSeriesIds);
  return [...new Set(selectedSeriesIds)].filter((id) => available.has(id));
}

export function replaceSelectedSeriesIdsInScope(
  selectedSeriesIds: readonly string[],
  nextSelectedSeriesIds: readonly string[],
  ownsSeriesId: (seriesId: string) => boolean,
): string[] {
  return [
    ...selectedSeriesIds.filter((seriesId) => !ownsSeriesId(seriesId)),
    ...nextSelectedSeriesIds.filter(ownsSeriesId),
  ].filter((seriesId, index, ids) => ids.indexOf(seriesId) === index);
}

/**
 * First-use initialization is distinct from rendering fallback: once a
 * descriptor exists, including with an empty selection, it remains exact.
 */
export function initializeSelectedSeriesIdsForUnconfiguredScope(
  selectedSeriesIds: readonly string[],
  availableSeriesIds: readonly string[],
  hasConfiguredSelection: boolean,
  ownsSeriesId: (seriesId: string) => boolean,
): string[] {
  return hasConfiguredSelection
    ? [...selectedSeriesIds]
    : replaceSelectedSeriesIdsInScope(
        selectedSeriesIds,
        availableSeriesIds,
        ownsSeriesId,
      );
}

export function toggleSelectedSeriesId(
  selectedSeriesIds: readonly string[],
  seriesId: string,
  selected: boolean,
): string[] {
  const next = new Set(selectedSeriesIds);
  if (selected) next.add(seriesId);
  else next.delete(seriesId);
  return [...next];
}

export function soloSeriesId(seriesId: string): string[] {
  return [seriesId];
}

export function selectAllSeriesIds(availableSeriesIds: readonly string[]): string[] {
  return [...new Set(availableSeriesIds)];
}

export function tableChartSeriesId(
  tableId: string,
  xAxisId: string,
  columnId: string,
): string {
  return `data.table:${tableId}:${xAxisId}:${columnId}`;
}

export function tableColumnIdFromSeriesId(seriesId: string): string {
  return seriesId.slice(seriesId.lastIndexOf(":") + 1);
}
