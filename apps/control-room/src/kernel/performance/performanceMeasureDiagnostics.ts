import type { RequestDiagnosticRecord } from "../api/RequestDiagnosticsController";

interface PerformanceDiagnosticsTarget {
  record(entry: RequestDiagnosticRecord): void;
}

interface PerformanceMeasureEntryLike {
  duration: number;
  entryType: string;
  name: string;
  startTime: number;
}

type PerformanceMeasureObserverCallback = (list: {
  getEntries: () => readonly PerformanceMeasureEntryLike[];
}) => void;

interface PerformanceMeasureObserverInstance {
  disconnect(): void;
  observe(options: { buffered?: boolean; type: "measure" }): void;
}

export interface PerformanceMeasureObserverConstructorLike {
  new (callback: PerformanceMeasureObserverCallback): PerformanceMeasureObserverInstance;
  supportedEntryTypes?: readonly string[];
}

interface PerformanceMeasureDiagnosticsOptions {
  diagnostics: PerformanceDiagnosticsTarget;
  namePrefix?: string;
  now?: () => number;
  observerConstructor?: PerformanceMeasureObserverConstructorLike | null;
  timeOrigin?: number;
}

const DEFAULT_PERFORMANCE_MEASURE_PREFIX = "fullmag.";
const REACT_RENDER_MEASURE_PREFIX = "fullmag.react.render.";
const MIN_REACT_RENDER_SAMPLE_INTERVAL_MS = 1_000;

export function startPerformanceMeasureDiagnostics({
  diagnostics,
  namePrefix = DEFAULT_PERFORMANCE_MEASURE_PREFIX,
  now = Date.now,
  observerConstructor = defaultPerformanceObserverConstructor(),
  timeOrigin = defaultPerformanceTimeOrigin(),
}: PerformanceMeasureDiagnosticsOptions): () => void {
  if (!observerConstructor) {
    return noop;
  }

  const supportedEntryTypes = observerConstructor.supportedEntryTypes;
  if (supportedEntryTypes && !supportedEntryTypes.includes("measure")) {
    return noop;
  }

  const sampler = createPerformanceMeasureSampler();
  const observer = new observerConstructor((list) => {
    for (const entry of list.getEntries()) {
      if (entry.entryType !== "measure") continue;
      if (!entry.name.startsWith(namePrefix)) continue;
      const timestampMs = resolvePerformanceTimestamp({
        entryStartTime: entry.startTime,
        now,
        timeOrigin,
      });
      const sample = sampler.sample(entry.name, timestampMs);
      if (!sample.record) continue;

      diagnostics.record({
        byteLength: null,
        channel: "performance",
        contentType: null,
        detail:
          sample.suppressedSinceLast > 0
            ? `performance measure;suppressedSinceLast=${sample.suppressedSinceLast}`
            : "performance measure",
        direction: "rx",
        durationMs: normalizePerformanceDuration(entry.duration),
        messageType: "measure",
        method: "MEASURE",
        outcome: "ok",
        path: entry.name,
        requestId: "performance-measure",
        status: null,
        timestampMs,
      });
    }
  });

  try {
    observer.observe({ buffered: true, type: "measure" });
  } catch {
    observer.disconnect();
    return noop;
  }

  return () => observer.disconnect();
}

function createPerformanceMeasureSampler(): {
  sample: (
    path: string,
    timestampMs: number,
  ) => { record: boolean; suppressedSinceLast: number };
} {
  const lastRecordedAt = new Map<string, number>();
  const suppressed = new Map<string, number>();
  return {
    sample(path, timestampMs) {
      if (!path.startsWith(REACT_RENDER_MEASURE_PREFIX)) {
        return { record: true, suppressedSinceLast: 0 };
      }

      const last = lastRecordedAt.get(path);
      if (
        last !== undefined &&
        timestampMs - last < MIN_REACT_RENDER_SAMPLE_INTERVAL_MS
      ) {
        suppressed.set(path, (suppressed.get(path) ?? 0) + 1);
        return { record: false, suppressedSinceLast: 0 };
      }

      const suppressedSinceLast = suppressed.get(path) ?? 0;
      suppressed.set(path, 0);
      lastRecordedAt.set(path, timestampMs);
      return { record: true, suppressedSinceLast };
    },
  };
}

function normalizePerformanceDuration(durationMs: number): number | null {
  if (!Number.isFinite(durationMs)) return null;
  return Math.max(0, durationMs);
}

function resolvePerformanceTimestamp({
  entryStartTime,
  now,
  timeOrigin,
}: {
  entryStartTime: number;
  now: () => number;
  timeOrigin: number;
}): number {
  if (Number.isFinite(timeOrigin) && Number.isFinite(entryStartTime)) {
    return Math.round(timeOrigin + entryStartTime);
  }

  return now();
}

function defaultPerformanceObserverConstructor(): PerformanceMeasureObserverConstructorLike | null {
  const observerConstructor = globalThis.PerformanceObserver;
  return typeof observerConstructor === "function"
    ? (observerConstructor as unknown as PerformanceMeasureObserverConstructorLike)
    : null;
}

function defaultPerformanceTimeOrigin(): number {
  return globalThis.performance?.timeOrigin ?? Number.NaN;
}

function noop(): void {}
