interface ScrollMetrics {
  readonly clientHeight: number;
  readonly scrollHeight: number;
  scrollTop: number;
}

export function isPreparationLogAtBottom(
  element: Pick<ScrollMetrics, "clientHeight" | "scrollHeight" | "scrollTop">,
  tolerancePx = 4,
): boolean {
  return (
    element.scrollHeight - element.scrollTop - element.clientHeight <= tolerancePx
  );
}

export function followPreparationLogTail(
  element: Pick<ScrollMetrics, "scrollHeight" | "scrollTop">,
  shouldFollow: boolean,
): void {
  if (shouldFollow) {
    element.scrollTop = element.scrollHeight;
  }
}
