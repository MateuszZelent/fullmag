// Wheel impulses commonly arrive 200–330 ms apart; keep their live pose out of
// the global stores until the whole navigation sequence has become quiet.
export const VIEWPORT_3D_CAMERA_CONTROLS_COMMIT_DELAY_MS = 500;

/** A wall-clock gap can be longer than a frame on a slow renderer.
 * Keep the gesture owner until an actual controls update has observed rest.
 */
export function scheduleViewport3DCameraRestCommit({
  delayMs, isCurrent, isMoving, requestFrame, commit,
}: {
  delayMs: number;
  isCurrent: () => boolean;
  isMoving: () => boolean;
  requestFrame: () => void;
  commit: () => void;
}): () => void {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const checkRest = () => {
    timer = null;
    if (cancelled || !isCurrent()) return;
    if (isMoving()) {
      requestFrame();
      timer = setTimeout(checkRest, delayMs);
    } else commit();
  };
  timer = setTimeout(checkRest, delayMs);
  return () => {
    cancelled = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
}
