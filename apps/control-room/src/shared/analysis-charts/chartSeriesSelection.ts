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

export function isTableChartSeriesId(seriesId: string): boolean {
  return seriesId.startsWith("data.table:");
}

export function isEnergyChartSeriesId(seriesId: string): boolean {
  return seriesId.startsWith("simulation.solver.energies:");
}

export function isFrequencyChartSeriesId(seriesId: string): boolean {
  return seriesId.startsWith("analysis.frequency-domain:");
}

export type ChartSeriesSelectionScope = "table" | "energy" | "frequency";

export function chartSeriesIdBelongsToScope(
  scope: ChartSeriesSelectionScope,
  seriesId: string,
): boolean {
  switch (scope) {
    case "table":
      return isTableChartSeriesId(seriesId);
    case "energy":
      return isEnergyChartSeriesId(seriesId);
    case "frequency":
      return isFrequencyChartSeriesId(seriesId);
  }
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
