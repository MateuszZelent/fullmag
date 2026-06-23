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
const CRITICAL_PERFORMANCE_MEASURE_MS = 100;

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
      const durationMs = normalizePerformanceDuration(entry.duration);
      const sample = sampler.sample(entry.name, timestampMs, durationMs);
      if (!sample.record) continue;

      diagnostics.record({
        byteLength: null,
        channel: "performance",
        contentType: null,
        detail: formatPerformanceMeasureDetail(
          entry.name,
          sample.suppressedSinceLast,
        ),
        direction: "rx",
        durationMs,
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
    durationMs: number | null,
  ) => { record: boolean; suppressedSinceLast: number };
} {
  const lastRecordedAt = new Map<string, number>();
  const suppressed = new Map<string, number>();
  return {
    sample(path, timestampMs, durationMs) {
      if (!path.startsWith(REACT_RENDER_MEASURE_PREFIX)) {
        return { record: true, suppressedSinceLast: 0 };
      }

      const critical =
        typeof durationMs === "number" &&
        durationMs >= CRITICAL_PERFORMANCE_MEASURE_MS;
      const last = lastRecordedAt.get(path);
      if (
        !critical &&
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

function formatPerformanceMeasureDetail(
  name: string,
  suppressedSinceLast: number,
): string {
  return [
    "performance measure",
    `bucket=${classifyPerformanceMeasureBucket(name)}`,
    `source=${sanitizeDetailValue(name)}`,
    `suppressedSinceLast=${suppressedSinceLast}`,
  ].join(";");
}

function classifyPerformanceMeasureBucket(name: string): string {
  if (name.startsWith(REACT_RENDER_MEASURE_PREFIX)) return "react-render";
  if (name.startsWith("fullmag.viewport3d.")) {
    if (/upload/i.test(name)) return "viewport-upload";
    return "viewport-build";
  }
  if (name.startsWith("fullmag.api.requestBinaryResource.")) {
    return "binary-decode";
  }
  if (name.startsWith("fullmag.resource") || name.includes("ResourceCache")) {
    return "resource-cache";
  }
  if (name.startsWith("fullmag.browser.")) return "startup";
  return "unknown";
}

function sanitizeDetailValue(value: string): string {
  return value.replace(/[;\n\r]/g, " ").slice(0, 240);
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
