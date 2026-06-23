import {
  DIAGNOSTIC_EVENT_NAMES,
  type DiagnosticAnyRecord,
  type DiagnosticBrowserMetricRecord,
  type DiagnosticMemoryRecord,
  type DiagnosticRecord,
  redactDiagnosticDetail,
} from "./diagnosticRecorderTypes";

interface BrowserSnapshotPerformanceLike {
  memory?: {
    jsHeapSizeLimit: number;
    totalJSHeapSize: number;
    usedJSHeapSize: number;
  };
}

interface BrowserSnapshotTarget {
  PerformanceObserver?: {
    supportedEntryTypes?: readonly string[];
  };
  devicePixelRatio?: number;
  innerHeight?: number;
  innerWidth?: number;
  navigator?: {
    hardwareConcurrency?: number;
    platform?: string;
    userAgent?: string;
  };
  performance?: BrowserSnapshotPerformanceLike;
}

export interface DiagnosticBrowserSnapshot {
  devicePixelRatio: number | null;
  hardwareConcurrency: number | null;
  jsHeapSizeLimitBytes: number | null;
  platform: string | null;
  performanceObserverSupport: Record<PerformanceObserverEntryType, boolean>;
  timestampMs: number;
  totalJSHeapBytes: number | null;
  usedJSHeapBytes: number | null;
  userAgent: string | null;
  viewportHeight: number | null;
  viewportWidth: number | null;
}

type PerformanceObserverEntryType =
  | "event"
  | "long-animation-frame"
  | "longtask"
  | "measure"
  | "navigation"
  | "paint"
  | "resource";

const RECORDER_ENTRY_TYPES: readonly PerformanceObserverEntryType[] = [
  "longtask",
  "long-animation-frame",
  "resource",
  "navigation",
  "paint",
  "event",
  "measure",
];

export function readDiagnosticBrowserSnapshot(
  target: BrowserSnapshotTarget | null = defaultBrowserSnapshotTarget(),
  now: () => number = Date.now,
): DiagnosticBrowserSnapshot {
  const supportedEntryTypes = new Set(
    target?.PerformanceObserver?.supportedEntryTypes ?? [],
  );
  const memory = target?.performance?.memory;
  return {
    devicePixelRatio: normalizePositiveNumber(target?.devicePixelRatio),
    hardwareConcurrency: normalizePositiveInteger(
      target?.navigator?.hardwareConcurrency,
    ),
    jsHeapSizeLimitBytes: normalizePositiveInteger(memory?.jsHeapSizeLimit),
    performanceObserverSupport: Object.fromEntries(
      RECORDER_ENTRY_TYPES.map((entryType) => [
        entryType,
        supportedEntryTypes.has(entryType),
      ]),
    ) as Record<PerformanceObserverEntryType, boolean>,
    platform: target?.navigator?.platform ?? null,
    timestampMs: now(),
    totalJSHeapBytes: normalizePositiveInteger(memory?.totalJSHeapSize),
    usedJSHeapBytes: normalizePositiveInteger(memory?.usedJSHeapSize),
    userAgent: target?.navigator?.userAgent ?? null,
    viewportHeight: normalizePositiveInteger(target?.innerHeight),
    viewportWidth: normalizePositiveInteger(target?.innerWidth),
  };
}

export function diagnosticBrowserSnapshotToRecords(
  snapshot: DiagnosticBrowserSnapshot,
): DiagnosticAnyRecord[] {
  const records: DiagnosticAnyRecord[] = [
    createBrowserSnapshotRecord(snapshot),
    createMemorySnapshotRecord(snapshot),
  ];

  for (const metric of [
    ["device-pixel-ratio", snapshot.devicePixelRatio, "ratio"],
    ["hardware-concurrency", snapshot.hardwareConcurrency, "count"],
    ["viewport-width", snapshot.viewportWidth, "count"],
    ["viewport-height", snapshot.viewportHeight, "count"],
    ["js-heap-used", snapshot.usedJSHeapBytes, "bytes"],
    ["js-heap-total", snapshot.totalJSHeapBytes, "bytes"],
    ["js-heap-limit", snapshot.jsHeapSizeLimitBytes, "bytes"],
  ] as const) {
    const [metricName, value, unit] = metric;
    if (typeof value === "number") {
      records.push(createBrowserMetricRecord(metricName, value, unit, snapshot));
    }
  }

  return records;
}

export function recordDiagnosticBrowserSnapshot(
  record: (record: DiagnosticAnyRecord) => void,
  snapshot: DiagnosticBrowserSnapshot = readDiagnosticBrowserSnapshot(),
): number {
  const records = diagnosticBrowserSnapshotToRecords(snapshot);
  for (const entry of records) {
    record(entry);
  }
  return records.length;
}

function createBrowserSnapshotRecord(
  snapshot: DiagnosticBrowserSnapshot,
): DiagnosticRecord {
  return {
    byteLength: null,
    detail: redactDiagnosticDetail({
      devicePixelRatio: snapshot.devicePixelRatio,
      hardwareConcurrency: snapshot.hardwareConcurrency,
      platform: snapshot.platform,
      supportEvent: snapshot.performanceObserverSupport.event,
      supportLongAnimationFrame:
        snapshot.performanceObserverSupport["long-animation-frame"],
      supportLongTask: snapshot.performanceObserverSupport.longtask,
      supportMeasure: snapshot.performanceObserverSupport.measure,
      supportNavigation: snapshot.performanceObserverSupport.navigation,
      supportPaint: snapshot.performanceObserverSupport.paint,
      supportResource: snapshot.performanceObserverSupport.resource,
      userAgent: snapshot.userAgent,
      viewportHeight: snapshot.viewportHeight,
      viewportWidth: snapshot.viewportWidth,
    }),
    droppedCount: 0,
    durationMs: null,
    id: "",
    kind: "browser-snapshot",
    lane: "browser",
    name: "browser.snapshot",
    severity: "info",
    startTimeMs: null,
    timestampMs: snapshot.timestampMs,
  };
}

function createMemorySnapshotRecord(
  snapshot: DiagnosticBrowserSnapshot,
): DiagnosticMemoryRecord {
  return {
    byteLength: snapshot.usedJSHeapBytes,
    detail: redactDiagnosticDetail({ source: "browser.snapshot" }),
    droppedCount: 0,
    durationMs: null,
    estimatedWebGLBytes: null,
    id: "",
    jsHeapLimitBytes: snapshot.jsHeapSizeLimitBytes,
    kind: "memory",
    lane: "memory",
    name: DIAGNOSTIC_EVENT_NAMES.memorySnapshot,
    severity: "info",
    startTimeMs: null,
    timestampMs: snapshot.timestampMs,
    totalJSHeapBytes: snapshot.totalJSHeapBytes,
    trackedBytes: 0,
    usedJSHeapBytes: snapshot.usedJSHeapBytes,
  };
}

function createBrowserMetricRecord(
  metricName: string,
  value: number,
  unit: DiagnosticBrowserMetricRecord["unit"],
  snapshot: DiagnosticBrowserSnapshot,
): DiagnosticBrowserMetricRecord {
  return {
    byteLength: unit === "bytes" ? value : null,
    detail: redactDiagnosticDetail({ source: "browser.snapshot" }),
    droppedCount: 0,
    durationMs: null,
    id: "",
    kind: "browser-metric",
    lane: "browser",
    metricName,
    name: `browser.metric.${metricName}`,
    severity: "info",
    startTimeMs: null,
    timestampMs: snapshot.timestampMs,
    unit,
    value,
  };
}

function normalizePositiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;
}

function normalizePositiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function defaultBrowserSnapshotTarget(): BrowserSnapshotTarget | null {
  return typeof window === "undefined"
    ? null
    : (window as unknown as BrowserSnapshotTarget);
}
