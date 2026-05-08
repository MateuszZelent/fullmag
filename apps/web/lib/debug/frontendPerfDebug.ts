export type PerfSample = {
  scope: string;
  phase: string;
  durationMs: number;
  timestampMs: number;
  meta?: Record<string, number | string | boolean | null>;
};

const perfListeners = new Set<() => void>();

declare global {
  interface Window {
    __FULLMAG_FRONTEND_PERF__?: PerfSample[];
  }
}

const MAX_SAMPLES = 400;
const MAX_META_KEYS = 24;
const MAX_TEXT_LENGTH = 160;
const EMPTY_FRONTEND_PERF_SAMPLES: PerfSample[] = [];

let frontendPerfSamples: PerfSample[] = [];

function sanitizeText(value: string): string {
  return value.length > MAX_TEXT_LENGTH ? `${value.slice(0, MAX_TEXT_LENGTH - 1)}...` : value;
}

function sanitizeNumber(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function sanitizeMeta(
  meta: Record<string, number | string | boolean | null> | undefined,
): Record<string, number | string | boolean | null> | undefined {
  if (!meta) {
    return undefined;
  }
  const next: Record<string, number | string | boolean | null> = {};
  for (const [key, value] of Object.entries(meta).slice(0, MAX_META_KEYS)) {
    const safeKey = sanitizeText(key);
    if (typeof value === "number") {
      next[safeKey] = sanitizeNumber(value);
    } else if (typeof value === "string") {
      next[safeKey] = sanitizeText(value);
    } else if (typeof value === "boolean" || value === null) {
      next[safeKey] = value;
    }
  }
  return next;
}

function sanitizePerfSample(sample: PerfSample): PerfSample {
  return {
    scope: sanitizeText(sample.scope),
    phase: sanitizeText(sample.phase),
    durationMs: sanitizeNumber(sample.durationMs),
    timestampMs: sanitizeNumber(sample.timestampMs),
    meta: sanitizeMeta(sample.meta),
  };
}

function getCanonicalPerfSamples(): PerfSample[] {
  if (typeof window === "undefined") {
    return EMPTY_FRONTEND_PERF_SAMPLES;
  }
  const globalSamples = window.__FULLMAG_FRONTEND_PERF__;
  if (!globalSamples) {
    window.__FULLMAG_FRONTEND_PERF__ = frontendPerfSamples;
    return frontendPerfSamples;
  }
  if (globalSamples !== frontendPerfSamples) {
    frontendPerfSamples = globalSamples;
  }
  return globalSamples;
}

export function recordFrontendPerfSample(sample: PerfSample): void {
  if (typeof window === "undefined") {
    return;
  }

  const safeSample = sanitizePerfSample(sample);
  const next = [...getCanonicalPerfSamples()];
  next.push(safeSample);
  if (next.length > MAX_SAMPLES) {
    next.splice(0, next.length - MAX_SAMPLES);
  }
  frontendPerfSamples = next;
  window.__FULLMAG_FRONTEND_PERF__ = frontendPerfSamples;
  for (const listener of perfListeners) {
    listener();
  }
}

const renderCounters = new Map<string, number>();

export function recordFrontendRender(scope: string, meta?: Record<string, number | string | boolean | null>): void {
  const nextCount = (renderCounters.get(scope) ?? 0) + 1;
  renderCounters.set(scope, nextCount);
  recordFrontendPerfSample({
    scope,
    phase: "render",
    durationMs: 0,
    timestampMs: typeof performance !== "undefined" ? performance.now() : Date.now(),
    meta: {
      renderCount: nextCount,
      ...(meta ?? {}),
    },
  });
}

export function getFrontendPerfSamples(): PerfSample[] {
  if (typeof window === "undefined") {
    return EMPTY_FRONTEND_PERF_SAMPLES;
  }
  const store = getCanonicalPerfSamples();
  return store.length > 0 ? store : EMPTY_FRONTEND_PERF_SAMPLES;
}

export function subscribeFrontendPerfSamples(listener: () => void): () => void {
  perfListeners.add(listener);
  return () => {
    perfListeners.delete(listener);
  };
}
