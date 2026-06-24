import {
  DIAGNOSTIC_EVENT_NAMES,
  type DiagnosticRecord,
  type DiagnosticRecordLane,
  type DiagnosticRecordSeverity,
  redactDiagnosticDetail,
} from "./diagnosticRecorderTypes";

type TimerHandle = unknown;

interface PerformanceEntryLike {
  decodedBodySize?: number;
  duration: number;
  encodedBodySize?: number;
  entryType: string;
  initiatorType?: string;
  name: string;
  nextHopProtocol?: string;
  startTime: number;
  transferSize?: number;
}

type PerformanceObserverCallback = (list: {
  getEntries: () => readonly PerformanceEntryLike[];
}) => void;

interface PerformanceObserverConstructorLike {
  new (callback: PerformanceObserverCallback): {
    disconnect(): void;
    observe(options: { buffered?: boolean; type: string }): void;
  };
  supportedEntryTypes?: readonly string[];
}

interface EarlyDiagnosticPerformanceLike {
  memory?: {
    jsHeapSizeLimit: number;
    totalJSHeapSize: number;
    usedJSHeapSize: number;
  };
  now(): number;
  timeOrigin?: number;
}

interface EarlyDiagnosticWindowLike {
  PerformanceObserver?: PerformanceObserverConstructorLike;
  __FULLMAG_CONFIG__?: {
    diagnosticRecorderMaxRecords?: unknown;
    enableDiagnosticRecorder?: unknown;
  };
  __FULLMAG_DIAGNOSTIC_RECORDER__?: EarlyDiagnosticRecorderGlobal;
  clearTimeout(handle: TimerHandle): void;
  location?: { href?: string };
  performance?: EarlyDiagnosticPerformanceLike;
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
}

interface EarlyDiagnosticRecordInput {
  byteLength?: number | null;
  detail?: Record<string, unknown>;
  durationMs?: number | null;
  kind: string;
  lane: DiagnosticRecordLane;
  name: string;
  severity?: DiagnosticRecordSeverity;
  startTimeMs?: number | null;
}

interface EarlyDiagnosticRecorderSnapshot {
  droppedCount: number;
  maxRecords: number;
  records: DiagnosticRecord[];
  stopped: boolean;
}

export interface EarlyDiagnosticRecorderGlobal {
  drain(): DiagnosticRecord[];
  exportArtifact(): {
    droppedCount: number;
    records: DiagnosticRecord[];
    url: string | null;
  };
  mark(name: string, detail?: Record<string, unknown>): void;
  record(input: EarlyDiagnosticRecordInput): void;
  snapshot(): EarlyDiagnosticRecorderSnapshot;
  stop(): void;
}

export interface InstallEarlyDiagnosticRecorderOptions {
  eventLoopLagProbe?: boolean;
  maxRecords?: number;
  observerConstructor?: PerformanceObserverConstructorLike | null;
  target?: EarlyDiagnosticWindowLike;
}

const DEFAULT_MAX_RECORDS = 512;
const EVENT_LOOP_PROBE_INTERVAL_MS = 100;
const EVENT_LOOP_LAG_THRESHOLD_MS = 50;
const EVENT_LOOP_PROBE_WINDOW_MS = 120_000;
const LONG_TASK_CRITICAL_MS = 100;
const LONG_ANIMATION_FRAME_WARNING_MS = 50;

export function installEarlyDiagnosticRecorder(
  options: InstallEarlyDiagnosticRecorderOptions = {},
): EarlyDiagnosticRecorderGlobal | null {
  const target = options.target ?? defaultWindow();
  if (!target?.performance) {
    return null;
  }

  if (target.__FULLMAG_DIAGNOSTIC_RECORDER__) {
    return target.__FULLMAG_DIAGNOSTIC_RECORDER__;
  }

  const performance = target.performance;
  const maxRecords = resolveMaxRecords(target, options.maxRecords);
  const records: DiagnosticRecord[] = [];
  const observers: Array<{ disconnect(): void }> = [];
  const cleanupCallbacks: Array<() => void> = [];
  let droppedCount = 0;
  let sequence = 0;
  let stopped = false;

  function record(input: EarlyDiagnosticRecordInput): void {
    if (stopped) return;
    const startTimeMs = normalizeNullableNumber(input.startTimeMs);
    const timestampMs = resolveTimestampMs(performance, startTimeMs);
    const nextRecord: DiagnosticRecord = {
      byteLength: normalizeNullableNumber(input.byteLength),
      detail: redactDiagnosticDetail(input.detail ?? {}),
      droppedCount: 0,
      durationMs: normalizeNullableNumber(input.durationMs),
      id: `early-${timestampMs}-${sequence++}`,
      kind: input.kind,
      lane: input.lane,
      name: input.name,
      severity: input.severity ?? "info",
      startTimeMs,
      timestampMs,
    };

    appendBoundedRecord(records, nextRecord, maxRecords, () => {
      droppedCount += 1;
    });
  }

  function mark(name: string, detail: Record<string, unknown> = {}): void {
    record({
      detail,
      kind: "mark",
      lane: "startup",
      name,
      severity: "info",
      startTimeMs: performance.now(),
    });
  }

  const recorder: EarlyDiagnosticRecorderGlobal = {
    drain() {
      const drained = records.map((entry) => ({ ...entry }));
      records.length = 0;
      return drained;
    },
    exportArtifact() {
      return {
        droppedCount,
        records: records.map((entry) => ({ ...entry })),
        url: target.location?.href ?? null,
      };
    },
    mark,
    record,
    snapshot() {
      return {
        droppedCount,
        maxRecords,
        records: records.map((entry) => ({ ...entry })),
        stopped,
      };
    },
    stop() {
      if (stopped) return;
      stopped = true;
      for (const observer of observers) {
        observer.disconnect();
      }
      for (const cleanup of cleanupCallbacks) {
        cleanup();
      }
    },
  };

  target.__FULLMAG_DIAGNOSTIC_RECORDER__ = recorder;
  mark(DIAGNOSTIC_EVENT_NAMES.instrumentationLoaded, {
    maxRecords,
    url: target.location?.href ?? null,
  });
  recordMemorySnapshot(performance, record);
  installPerformanceObservers({
    observerConstructor:
      options.observerConstructor ?? target.PerformanceObserver ?? null,
    observers,
    record,
  });

  if (options.eventLoopLagProbe !== false) {
    cleanupCallbacks.push(startEventLoopLagProbe(target, performance, record));
  }

  return recorder;
}

function installPerformanceObservers({
  observerConstructor,
  observers,
  record,
}: {
  observerConstructor: PerformanceObserverConstructorLike | null;
  observers: Array<{ disconnect(): void }>;
  record: (input: EarlyDiagnosticRecordInput) => void;
}): void {
  if (!observerConstructor) return;
  const supported = observerConstructor.supportedEntryTypes;
  const entryTypes = [
    "longtask",
    "long-animation-frame",
    "resource",
    "navigation",
    "paint",
    "event",
    "measure",
  ];
  const supportedTypes = supported ? new Set(supported) : null;

  for (const type of entryTypes) {
    if (supportedTypes && !supportedTypes.has(type)) continue;
    const observer = new observerConstructor((list) => {
      for (const entry of list.getEntries()) {
        const diagnostic = performanceEntryToDiagnosticRecord(entry);
        if (diagnostic) record(diagnostic);
      }
    });

    try {
      observer.observe({ buffered: true, type });
      observers.push(observer);
    } catch {
      observer.disconnect();
    }
  }
}

function performanceEntryToDiagnosticRecord(
  entry: PerformanceEntryLike,
): EarlyDiagnosticRecordInput | null {
  if (entry.entryType === "longtask") {
    return {
      detail: { source: entry.name || "unknown" },
      durationMs: entry.duration,
      kind: "performance",
      lane: "main-thread",
      name: DIAGNOSTIC_EVENT_NAMES.longTask,
      severity: entry.duration >= LONG_TASK_CRITICAL_MS ? "critical" : "warning",
      startTimeMs: entry.startTime,
    };
  }

  if (entry.entryType === "long-animation-frame") {
    return {
      detail: { source: entry.name || "unknown" },
      durationMs: entry.duration,
      kind: "performance",
      lane: "main-thread",
      name: DIAGNOSTIC_EVENT_NAMES.longAnimationFrame,
      severity:
        entry.duration >= LONG_TASK_CRITICAL_MS
          ? "critical"
          : entry.duration >= LONG_ANIMATION_FRAME_WARNING_MS
            ? "warning"
            : "info",
      startTimeMs: entry.startTime,
    };
  }

  if (entry.entryType === "event") {
    if (entry.duration < LONG_ANIMATION_FRAME_WARNING_MS) {
      return null;
    }
    return {
      detail: { source: entry.name || "unknown" },
      durationMs: entry.duration,
      kind: "event",
      lane: "main-thread",
      name: "browser.event",
      severity: entry.duration >= LONG_TASK_CRITICAL_MS ? "critical" : "warning",
      startTimeMs: entry.startTime,
    };
  }

  if (entry.entryType === "resource") {
    return {
      byteLength: resolveResourceByteLength(entry),
      detail: {
        initiatorType: entry.initiatorType ?? null,
        nextHopProtocol: entry.nextHopProtocol ?? null,
        source: shortSourceName(entry.name),
      },
      durationMs: entry.duration,
      kind: "resource",
      lane: "api",
      name: "browser.resource",
      severity: "info",
      startTimeMs: entry.startTime,
    };
  }

  if (entry.entryType === "measure") {
    return {
      detail: { source: entry.name },
      durationMs: entry.duration,
      kind: "measure",
      lane: entry.name.startsWith("fullmag.react.render.")
        ? "react"
        : entry.name.startsWith("fullmag.viewport3d.")
          ? "viewport-3d"
          : "startup",
      name: entry.name,
      severity: entry.duration >= LONG_TASK_CRITICAL_MS ? "warning" : "info",
      startTimeMs: entry.startTime,
    };
  }

  if (entry.entryType === "navigation" || entry.entryType === "paint") {
    return {
      detail: { source: entry.name },
      durationMs: entry.duration,
      kind: entry.entryType,
      lane: "startup",
      name: `browser.${entry.entryType}.${entry.name || "entry"}`,
      severity: "info",
      startTimeMs: entry.startTime,
    };
  }

  return null;
}

function startEventLoopLagProbe(
  target: EarlyDiagnosticWindowLike,
  performance: EarlyDiagnosticPerformanceLike,
  record: (input: EarlyDiagnosticRecordInput) => void,
): () => void {
  let timer: TimerHandle | null = null;
  let stopped = false;
  const startedAtMs = performance.now();
  let expectedAtMs = startedAtMs + EVENT_LOOP_PROBE_INTERVAL_MS;

  function schedule(): void {
    if (stopped) return;
    timer = target.setTimeout(() => {
      const now = performance.now();
      const lagMs = now - expectedAtMs;
      if (lagMs >= EVENT_LOOP_LAG_THRESHOLD_MS) {
        record({
          detail: { expectedAtMs, lagMs },
          durationMs: lagMs,
          kind: "probe",
          lane: "main-thread",
          name: DIAGNOSTIC_EVENT_NAMES.eventLoopLag,
          severity: lagMs >= LONG_TASK_CRITICAL_MS ? "critical" : "warning",
          startTimeMs: expectedAtMs,
        });
      }
      expectedAtMs = now + EVENT_LOOP_PROBE_INTERVAL_MS;
      if (now - startedAtMs < EVENT_LOOP_PROBE_WINDOW_MS) {
        schedule();
      }
    }, EVENT_LOOP_PROBE_INTERVAL_MS);
  }

  schedule();

  return () => {
    stopped = true;
    if (timer !== null) {
      target.clearTimeout(timer);
    }
  };
}

function recordMemorySnapshot(
  performance: EarlyDiagnosticPerformanceLike,
  record: (input: EarlyDiagnosticRecordInput) => void,
): void {
  const memory = performance.memory;
  record({
    byteLength: memory?.usedJSHeapSize ?? null,
    detail: {
      jsHeapSizeLimit: memory?.jsHeapSizeLimit ?? null,
      totalJSHeapSize: memory?.totalJSHeapSize ?? null,
      usedJSHeapSize: memory?.usedJSHeapSize ?? null,
    },
    kind: "memory",
    lane: "memory",
    name: DIAGNOSTIC_EVENT_NAMES.memorySnapshot,
    severity: "info",
    startTimeMs: performance.now(),
  });
}

function appendBoundedRecord(
  records: DiagnosticRecord[],
  record: DiagnosticRecord,
  maxRecords: number,
  onDropped: () => void,
): void {
  records.push(record);
  if (records.length <= maxRecords) return;

  const removableIndex = records.findIndex((entry) => entry.severity !== "critical");
  if (removableIndex >= 0) {
    records.splice(removableIndex, 1);
    onDropped();
    return;
  }

  records.pop();
  onDropped();
}

function resolveResourceByteLength(entry: PerformanceEntryLike): number | null {
  const byteLength =
    entry.transferSize ?? entry.encodedBodySize ?? entry.decodedBodySize;
  return normalizeNullableNumber(byteLength);
}

function resolveTimestampMs(
  performance: EarlyDiagnosticPerformanceLike,
  startTimeMs: number | null,
): number {
  const timeOrigin = performance.timeOrigin;
  if (
    typeof timeOrigin === "number" &&
    Number.isFinite(timeOrigin) &&
    typeof startTimeMs === "number"
  ) {
    return Math.round(timeOrigin + startTimeMs);
  }
  return Math.round(Date.now());
}

function resolveMaxRecords(
  target: EarlyDiagnosticWindowLike,
  requested: number | undefined,
): number {
  const configured = target.__FULLMAG_CONFIG__?.diagnosticRecorderMaxRecords;
  const raw = typeof requested === "number" ? requested : configured;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_MAX_RECORDS;
  }
  return Math.max(1, Math.trunc(raw));
}

function normalizeNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : null;
}

function shortSourceName(source: string): string {
  try {
    const url = new URL(source, "http://localhost");
    return url.pathname || source;
  } catch {
    return source.slice(0, 160);
  }
}

function defaultWindow(): EarlyDiagnosticWindowLike | null {
  return typeof window === "undefined"
    ? null
    : (window as unknown as EarlyDiagnosticWindowLike);
}
