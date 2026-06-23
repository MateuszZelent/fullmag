import type { RequestDiagnosticRecord } from "../api/RequestDiagnosticsController";

interface BrowserActivityDiagnosticsTarget {
  record(entry: RequestDiagnosticRecord): void;
}

interface PerformanceEntryLike {
  attribution?: readonly PerformanceAttributionLike[];
  blockingDuration?: number;
  duration: number;
  entryType: string;
  name: string;
  renderStart?: number;
  scripts?: readonly LongAnimationFrameScriptLike[];
  startTime: number;
  styleAndLayoutStart?: number;
}

interface PerformanceAttributionLike {
  containerId?: string;
  containerName?: string;
  containerSrc?: string;
  containerType?: string;
  entryType?: string;
  name?: string;
}

interface LongAnimationFrameScriptLike {
  duration?: number;
  forcedStyleAndLayoutDuration?: number;
  invoker?: string;
  invokerType?: string;
  pauseDuration?: number;
  sourceFunctionName?: string;
  sourceURL?: string;
  windowAttribution?: string;
}

type PerformanceEntryObserverCallback = (list: {
  getEntries: () => readonly PerformanceEntryLike[];
}) => void;

export interface PerformanceEntryObserverConstructorLike {
  new (callback: PerformanceEntryObserverCallback): {
    disconnect(): void;
    observe(options: { buffered?: boolean; type: string }): void;
  };
  supportedEntryTypes?: readonly string[];
}

interface BrowserActivityDiagnosticsOptions {
  diagnostics: BrowserActivityDiagnosticsTarget;
  now?: () => number;
  observerConstructor?: PerformanceEntryObserverConstructorLike | null;
  timeOrigin?: number;
}

const LONG_TASK_PATH = "fullmag.browser.longtask";
const LONG_ANIMATION_FRAME_PATH = "fullmag.browser.long-animation-frame";
const MIN_BROWSER_ACTIVITY_SAMPLE_INTERVAL_MS = 1_000;
const CRITICAL_BROWSER_ACTIVITY_MS = 100;

export function startBrowserActivityDiagnostics({
  diagnostics,
  now = Date.now,
  observerConstructor = defaultPerformanceObserverConstructor(),
  timeOrigin = defaultPerformanceTimeOrigin(),
}: BrowserActivityDiagnosticsOptions): () => void {
  if (!observerConstructor) return noop;
  const supportedEntryTypes = observerConstructor.supportedEntryTypes;
  const supportsLongTask =
    !supportedEntryTypes || supportedEntryTypes.includes("longtask");
  const supportsLongAnimationFrame =
    !supportedEntryTypes || supportedEntryTypes.includes("long-animation-frame");
  if (!supportsLongTask && !supportsLongAnimationFrame) {
    return noop;
  }

  const observers: Array<{ disconnect(): void }> = [];
  const sampler = createBrowserActivitySampler();

  if (supportsLongTask) {
    const observer = new observerConstructor((list) => {
      for (const entry of list.getEntries()) {
        if (entry.entryType !== "longtask") continue;
        const timestampMs = resolvePerformanceTimestamp({
          entryStartTime: entry.startTime,
          now,
          timeOrigin,
        });
        const durationMs = normalizeDuration(entry.duration);
        const sample = sampler.sample(LONG_TASK_PATH, timestampMs, durationMs);
        if (!sample.record) continue;
        diagnostics.record({
          byteLength: null,
          channel: "performance",
          contentType: null,
          detail: appendSamplingDetail(
            formatLongTaskDetail(entry),
            sample.suppressedSinceLast,
          ),
          direction: "rx",
          durationMs,
          messageType: "longtask",
          method: "LONGTASK",
          outcome: "ok",
          path: LONG_TASK_PATH,
          requestId: "browser-longtask",
          status: null,
          timestampMs,
        });
      }
    });

    try {
      observer.observe({ buffered: true, type: "longtask" });
      observers.push(observer);
    } catch {
      observer.disconnect();
    }
  }

  if (supportsLongAnimationFrame) {
    const observer = new observerConstructor((list) => {
      for (const entry of list.getEntries()) {
        if (entry.entryType !== "long-animation-frame") continue;
        const timestampMs = resolvePerformanceTimestamp({
          entryStartTime: entry.startTime,
          now,
          timeOrigin,
        });
        const durationMs = normalizeDuration(entry.duration);
        const sample = sampler.sample(
          LONG_ANIMATION_FRAME_PATH,
          timestampMs,
          durationMs,
        );
        if (!sample.record) continue;
        diagnostics.record({
          byteLength: null,
          channel: "performance",
          contentType: null,
          detail: appendSamplingDetail(
            formatLongAnimationFrameDetail(entry),
            sample.suppressedSinceLast,
          ),
          direction: "rx",
          durationMs,
          messageType: "long-animation-frame",
          method: "LOAF",
          outcome: "ok",
          path: LONG_ANIMATION_FRAME_PATH,
          requestId: "browser-long-animation-frame",
          status: null,
          timestampMs,
        });
      }
    });

    try {
      observer.observe({ buffered: true, type: "long-animation-frame" });
      observers.push(observer);
    } catch {
      observer.disconnect();
    }
  }

  if (observers.length === 0) return noop;
  return () => {
    for (const observer of observers) {
      observer.disconnect();
    }
  };
}

function createBrowserActivitySampler(): {
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
      const last = lastRecordedAt.get(path);
      if (
        (durationMs ?? 0) < CRITICAL_BROWSER_ACTIVITY_MS &&
        last !== undefined &&
        timestampMs - last < MIN_BROWSER_ACTIVITY_SAMPLE_INTERVAL_MS
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

function appendSamplingDetail(detail: string, suppressedSinceLast: number): string {
  return `${detail};suppressedSinceLast=${suppressedSinceLast}`;
}

function formatLongTaskDetail(entry: PerformanceEntryLike): string {
  return [
    `name=${sanitizeDetailValue(entry.name || "unknown")}`,
    `source=${sanitizeDetailValue(resolveLongTaskSource(entry))}`,
    `attribution=${sanitizeDetailValue(formatLongTaskAttribution(entry))}`,
  ].join(";");
}

function resolveLongTaskSource(entry: PerformanceEntryLike): string {
  const attribution = entry.attribution?.[0];
  if (!attribution) return entry.name || "unknown";
  return (
    attribution.containerName ||
    attribution.containerId ||
    attribution.containerSrc ||
    attribution.containerType ||
    attribution.name ||
    entry.name ||
    "unknown"
  );
}

function formatLongTaskAttribution(entry: PerformanceEntryLike): string {
  const attribution = entry.attribution ?? [];
  if (attribution.length === 0) return "none";
  const formatted: string[] = [];
  for (const item of attribution.slice(0, 3)) {
    const parts = [
      item.name,
      item.containerType,
      item.containerName,
      item.containerId,
      item.containerSrc,
    ].filter(Boolean);
    if (parts.length > 0) {
      formatted.push(parts.join("/"));
    }
  }
  return formatted.join(",") || "unknown";
}

function formatLongAnimationFrameDetail(entry: PerformanceEntryLike): string {
  const scripts = (entry.scripts ?? []).toSorted(
    (left, right) => (right.duration ?? 0) - (left.duration ?? 0),
  );
  const primaryScript = scripts[0];
  return [
    `source=${sanitizeDetailValue(formatScriptIdentity(primaryScript))}`,
    `scripts=${sanitizeDetailValue(formatLongAnimationFrameScripts(scripts))}`,
    `blockingMs=${formatOptionalNumber(entry.blockingDuration)}`,
    `renderStartMs=${formatOptionalNumber(entry.renderStart)}`,
    `styleLayoutStartMs=${formatOptionalNumber(entry.styleAndLayoutStart)}`,
  ].join(";");
}

function formatLongAnimationFrameScripts(
  scripts: readonly LongAnimationFrameScriptLike[],
): string {
  if (scripts.length === 0) return "none";
  return scripts.slice(0, 3).map(formatScriptSource).join(",");
}

function formatScriptSource(script: LongAnimationFrameScriptLike | undefined): string {
  if (!script) return "unknown";
  const identity = formatScriptIdentity(script);
  const duration = formatOptionalNumber(script.duration);
  return `${identity}:${duration}ms`;
}

function formatScriptIdentity(script: LongAnimationFrameScriptLike | undefined): string {
  if (!script) return "unknown";
  const sourceUrl = script.sourceURL ? shortSourceUrl(script.sourceURL) : "unknown";
  const functionName = script.sourceFunctionName || script.invoker || "anonymous";
  return `${sourceUrl}#${functionName}`;
}

function shortSourceUrl(sourceUrl: string): string {
  try {
    const url = new URL(sourceUrl, globalThis.location?.href);
    const segments = url.pathname.split("/").filter(Boolean);
    return segments.slice(-2).join("/") || url.hostname || sourceUrl;
  } catch {
    const segments = sourceUrl.split("/").filter(Boolean);
    return segments.slice(-2).join("/") || sourceUrl;
  }
}

function formatOptionalNumber(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toFixed(1)
    : "n/a";
}

function sanitizeDetailValue(value: string): string {
  return value.replace(/[;\n\r]/g, " ").slice(0, 240);
}

function normalizeDuration(durationMs: number): number | null {
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

function defaultPerformanceObserverConstructor(): PerformanceEntryObserverConstructorLike | null {
  const observerConstructor = globalThis.PerformanceObserver;
  return typeof observerConstructor === "function"
    ? (observerConstructor as unknown as PerformanceEntryObserverConstructorLike)
    : null;
}

function defaultPerformanceTimeOrigin(): number {
  return globalThis.performance?.timeOrigin ?? Number.NaN;
}

function noop(): void {}
