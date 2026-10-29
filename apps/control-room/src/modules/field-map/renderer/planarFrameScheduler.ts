export interface FrameHost {
  cancelAnimationFrame(id: number): void;
  requestAnimationFrame(callback: FrameRequestCallback): number;
}

export function createPlanarFrameScheduler(
  host: FrameHost,
  render: () => void,
) {
  let frame: number | null = null;
  return {
    dispose() {
      if (frame !== null) host.cancelAnimationFrame(frame);
      frame = null;
    },
    invalidate() {
      if (frame !== null) return;
      frame = host.requestAnimationFrame(() => {
        frame = null;
        render();
      });
    },
  };
}

/**
 * Keep only the latest value pushed during a frame and publish it once on the
 * next animation frame (pointer gestures fire far more often than frames).
 */
export function createCoalescedFramePublisher<T>(
  host: FrameHost,
  publish: (value: T) => void,
) {
  let pending: { value: T } | null = null;
  const scheduler = createPlanarFrameScheduler(host, () => {
    const next = pending;
    pending = null;
    if (next) publish(next.value);
  });
  return {
    dispose() {
      pending = null;
      scheduler.dispose();
    },
    push(value: T) {
      pending = { value };
      scheduler.invalidate();
    },
  };
}
