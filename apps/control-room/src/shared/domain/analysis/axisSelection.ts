export function yAxisIdsAfterXAxisSelection(
  yAxisIds: readonly string[],
  xAxisId: string,
): string[] {
  return yAxisIds.filter((id) => id !== xAxisId);
}
