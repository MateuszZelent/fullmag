export function sanitizeSelectedSeriesIds(
  selectedSeriesIds: readonly string[],
  availableSeriesIds: readonly string[],
): string[] {
  const available = new Set(availableSeriesIds);
  return [...new Set(selectedSeriesIds)].filter((id) => available.has(id));
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
