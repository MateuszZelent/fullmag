export function formatResultsSampleOrdinal(
  sampleIndex: number | null | undefined,
  sampleCount: number | null | undefined,
): string {
  if (
    typeof sampleIndex !== "number" ||
    !Number.isSafeInteger(sampleIndex) ||
    sampleIndex < 0 ||
    typeof sampleCount !== "number" ||
    !Number.isSafeInteger(sampleCount) ||
    sampleCount <= 0 ||
    sampleIndex >= sampleCount
  ) {
    return "Sample unavailable";
  }
  return `Sample ${sampleIndex + 1} of ${sampleCount}`;
}
