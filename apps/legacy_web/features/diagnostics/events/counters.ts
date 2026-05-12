/**
 * Diagnostics – event counters.
 *
 * Lightweight performance counters for frontend instrumentation.
 * Per Faza 0 of the master plan — counters for requests and renders.
 */

interface CounterEntry {
  count: number;
  lastAt: number;
}

const counters = new Map<string, CounterEntry>();

export function incrementCounter(name: string): void {
  const entry = counters.get(name);
  if (entry) {
    entry.count += 1;
    entry.lastAt = Date.now();
  } else {
    counters.set(name, { count: 1, lastAt: Date.now() });
  }
}

export function readCounter(name: string): CounterEntry {
  return counters.get(name) ?? { count: 0, lastAt: 0 };
}

export function resetCounter(name: string): void {
  counters.delete(name);
}

export function resetAllCounters(): void {
  counters.clear();
}

export function dumpCounters(): Record<string, CounterEntry> {
  const result: Record<string, CounterEntry> = {};
  for (const [key, value] of counters) {
    result[key] = { ...value };
  }
  return result;
}

/* ── Named counter helpers ── */

export const requestCounters = {
  apiCall: (endpoint: string) => incrementCounter(`api:${endpoint}`),
  wsMessage: (type: string) => incrementCounter(`ws:${type}`),
  previewFetch: () => incrementCounter("preview:fetch"),
  artifactFetch: () => incrementCounter("artifact:fetch"),
} as const;

export const renderCounters = {
  viewportFrame: () => incrementCounter("render:viewport-frame"),
  meshUpdate: () => incrementCounter("render:mesh-update"),
  arrowUpdate: () => incrementCounter("render:arrow-update"),
  sidebarRender: () => incrementCounter("render:sidebar"),
} as const;
