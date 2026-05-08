export interface LiveBufferTransitionOptions {
  destination: Float32Array;
  target: Float32Array;
  durationMs?: number;
  maxAnimatedValues?: number;
  markNeedsUpdate: () => void;
  scheduleInvalidate: () => void;
  now?: () => number;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (handle: number) => void;
  reducedMotion?: boolean;
}

const DEFAULT_DURATION_MS = 160;
const DEFAULT_MAX_ANIMATED_VALUES = 750_000;

function defaultNow(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function shouldAnimateLiveBuffer(args: {
  length: number;
  maxAnimatedValues?: number;
  reducedMotion?: boolean;
}): boolean {
  const maxAnimatedValues = args.maxAnimatedValues ?? DEFAULT_MAX_ANIMATED_VALUES;
  return args.length > 0 && args.length <= maxAnimatedValues && args.reducedMotion !== true;
}

export function applyLiveBufferTransition({
  destination,
  target,
  durationMs = DEFAULT_DURATION_MS,
  maxAnimatedValues,
  markNeedsUpdate,
  scheduleInvalidate,
  now = defaultNow,
  requestFrame,
  cancelFrame,
  reducedMotion = prefersReducedMotion(),
}: LiveBufferTransitionOptions): (finish?: boolean) => void {
  const length = Math.min(destination.length, target.length);
  const copyImmediate = () => {
    destination.set(target.subarray(0, length), 0);
    markNeedsUpdate();
    scheduleInvalidate();
  };

  const request =
    requestFrame ??
    (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function"
      ? window.requestAnimationFrame.bind(window)
      : null);
  const cancel =
    cancelFrame ??
    (typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function"
      ? window.cancelAnimationFrame.bind(window)
      : null);

  if (
    length !== target.length ||
    !request ||
    durationMs <= 0 ||
    !shouldAnimateLiveBuffer({ length, maxAnimatedValues, reducedMotion })
  ) {
    copyImmediate();
    return () => {};
  }

  const from = destination.slice(0, length);
  const to = target.slice(0, length);
  const start = now();
  let frame = 0;
  let cancelled = false;

  const step: FrameRequestCallback = (timestamp) => {
    if (cancelled) {
      return;
    }
    const elapsed = Math.max(0, timestamp - start);
    const linear = Math.min(1, elapsed / durationMs);
    const eased = linear * linear * (3 - 2 * linear);
    for (let index = 0; index < length; index += 1) {
      destination[index] = from[index] + (to[index] - from[index]) * eased;
    }
    markNeedsUpdate();
    scheduleInvalidate();
    if (linear < 1) {
      frame = request(step);
    }
  };

  frame = request(step);

  return (finish = false) => {
    cancelled = true;
    if (frame && cancel) {
      cancel(frame);
    }
    if (finish) {
      copyImmediate();
    }
  };
}
