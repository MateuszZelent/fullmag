export function nextVisualizationRadioValue<T extends string>(
  values: readonly T[],
  currentValue: T,
  key: string,
): T {
  const currentIndex = Math.max(0, values.indexOf(currentValue));
  if (key === "Home") return values[0] ?? currentValue;
  if (key === "End") return values.at(-1) ?? currentValue;
  if (
    key !== "ArrowLeft" &&
    key !== "ArrowRight" &&
    key !== "ArrowUp" &&
    key !== "ArrowDown"
  ) {
    return currentValue;
  }
  const offset = key === "ArrowLeft" || key === "ArrowUp" ? -1 : 1;
  return (
    values[(currentIndex + offset + values.length) % values.length] ?? currentValue
  );
}
