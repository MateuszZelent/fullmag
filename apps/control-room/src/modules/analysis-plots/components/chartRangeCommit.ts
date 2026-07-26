export function scheduleRangeCommit(
  timerRef: { current: number | null },
  commit: () => void,
): void {
  cancelRangeCommit(timerRef);
  timerRef.current = window.setTimeout(() => {
    timerRef.current = null;
    commit();
  }, 200);
}

export function cancelRangeCommit(timerRef: { current: number | null }): void {
  if (timerRef.current === null) return;
  window.clearTimeout(timerRef.current);
  timerRef.current = null;
}
