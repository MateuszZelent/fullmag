export const DIAGNOSTIC_ARTIFACT_VERSION = 1;

export const DIAGNOSTIC_EVENT_NAMES = {
  instrumentationLoaded: "instrumentation-client.loaded",
  kernelCreated: "kernel.created",
  kernelProviderMounted: "kernel.provider-mounted",
  workspaceSettled: "workspace.settled",
  longTask: "browser.longtask",
  longAnimationFrame: "browser.long-animation-frame",
  eventLoopLag: "browser.event-loop-lag",
  requestStarted: "request.started",
  requestFinished: "request.finished",
  resourceCacheSet: "resource-cache.set",
  resourceCacheEvicted: "resource-cache.evicted",
  viewport3DMounted: "viewport-3d.mounted",
  viewport3DCanvasReady: "viewport-3d.canvas-ready",
  viewport3DContextLost: "viewport-3d.context-lost",
  viewport3DContextRestored: "viewport-3d.context-restored",
  viewport3DResourceTracked: "viewport-3d.resource-tracked",
  viewport3DResourceReleased: "viewport-3d.resource-released",
  memorySnapshot: "memory.snapshot",
  leakCheck: "memory.leak-check",
} as const;

export type DiagnosticRecorderProfile =
  | "boot"
  | "session"
  | "viewport-3d"
  | "memory-leak"
  | "forensic";

export type DiagnosticRecordSeverity = "info" | "warning" | "critical";

export type DiagnosticRecordLane =
  | "api"
  | "browser"
  | "console"
  | "main-thread"
  | "memory"
  | "react"
  | "resource-cache"
  | "scenario"
  | "startup"
  | "viewport-3d"
  | "webgl"
  | "worker";

export type DiagnosticScalar = boolean | number | string | null;

export type DiagnosticRecordDetail = Record<string, DiagnosticScalar>;

export interface DiagnosticRecord {
  byteLength: number | null;
  detail: DiagnosticRecordDetail;
  droppedCount: number;
  durationMs: number | null;
  id: string;
  kind: string;
  lane: DiagnosticRecordLane;
  name: string;
  severity: DiagnosticRecordSeverity;
  startTimeMs: number | null;
  timestampMs: number;
}

export type DiagnosticRequestOutcome =
  | "aborted"
  | "error"
  | "network-error"
  | "ok"
  | "sent";

export interface DiagnosticRequestRecord extends DiagnosticRecord {
  contentType: string | null;
  etag: string | null;
  method: string;
  outcome: DiagnosticRequestOutcome;
  path: string;
  query: string | null;
  requestId: string | null;
  resourceKey: string | null;
  status: number | null;
}

export interface DiagnosticResourceRecord extends DiagnosticRecord {
  cacheAction:
    | "abort"
    | "evict"
    | "hit"
    | "invalidate"
    | "miss"
    | "set"
    | "stale-skip";
  revision: number | string | null;
  resourceKey: string;
}

export interface DiagnosticMemoryRecord extends DiagnosticRecord {
  estimatedWebGLBytes: number | null;
  jsHeapLimitBytes: number | null;
  totalJSHeapBytes: number | null;
  trackedBytes: number;
  usedJSHeapBytes: number | null;
}

export interface DiagnosticViewport3DRecord extends DiagnosticRecord {
  contextLost: boolean | null;
  dirtyReason: string | null;
  geometries: number;
  materials: number;
  renderTargets: number;
  textures: number;
  workers: number;
}

export interface DiagnosticConsoleRecord extends DiagnosticRecord {
  level: "error" | "info" | "warn";
  message: string;
  source: string | null;
}

export interface DiagnosticReactRecord extends DiagnosticRecord {
  componentId: string;
  phase: "mount" | "nested-update" | "update";
}

export interface DiagnosticBrowserMetricRecord extends DiagnosticRecord {
  metricName: string;
  unit: "bytes" | "count" | "ms" | "ratio";
  value: number;
}

export interface DiagnosticManifest {
  artifactVersion: typeof DIAGNOSTIC_ARTIFACT_VERSION;
  branch: string | null;
  browserName: string | null;
  browserVersion: string | null;
  commit: string | null;
  createdAtIso: string;
  profile: DiagnosticRecorderProfile;
  scenario: string;
  url: string | null;
}

export interface DiagnosticSummary {
  criticalCount: number;
  droppedCount: number;
  recordCount: number;
  slowestRecord: DiagnosticRecord | null;
  warningCount: number;
}

export interface DiagnosticSuspect {
  detail: DiagnosticRecordDetail;
  id: string;
  lane: DiagnosticRecordLane;
  reason: string;
  severity: DiagnosticRecordSeverity;
}

export interface DiagnosticSuspectReport {
  generatedAtIso: string;
  suspects: DiagnosticSuspect[];
  text: string;
}

export interface DiagnosticArtifactV1 {
  artifactVersion: typeof DIAGNOSTIC_ARTIFACT_VERSION;
  manifest: DiagnosticManifest;
  streams: {
    browserMetrics: DiagnosticBrowserMetricRecord[];
    console: DiagnosticConsoleRecord[];
    memory: DiagnosticMemoryRecord[];
    performance: DiagnosticRecord[];
    react: DiagnosticReactRecord[];
    requests: DiagnosticRequestRecord[];
    resources: DiagnosticResourceRecord[];
    timeline: DiagnosticRecord[];
    viewport3d: DiagnosticViewport3DRecord[];
  };
  summary: DiagnosticSummary;
  suspectReport: DiagnosticSuspectReport;
}

export type DiagnosticAnyRecord =
  | DiagnosticBrowserMetricRecord
  | DiagnosticConsoleRecord
  | DiagnosticMemoryRecord
  | DiagnosticReactRecord
  | DiagnosticRecord
  | DiagnosticRequestRecord
  | DiagnosticResourceRecord
  | DiagnosticViewport3DRecord;

export type DiagnosticRequestRecordInput = Omit<
  DiagnosticRequestRecord,
  "detail" | "droppedCount"
> & {
  detail?: DiagnosticRecordDetail & {
    authorization?: unknown;
    body?: unknown;
    cookie?: unknown;
    headers?: unknown;
    responseBody?: unknown;
    token?: unknown;
  };
  droppedCount?: number;
};

const REDACTED_DETAIL_KEYS = new Set([
  "authorization",
  "body",
  "cookie",
  "headers",
  "responseBody",
  "token",
]);

export function normalizeDiagnosticRequestRecord(
  input: DiagnosticRequestRecordInput,
): DiagnosticRequestRecord {
  return {
    ...input,
    detail: redactDiagnosticDetail(input.detail ?? {}),
    droppedCount: normalizeDroppedCount(input.droppedCount),
  };
}

export function redactDiagnosticDetail(
  detail: Record<string, unknown>,
): DiagnosticRecordDetail {
  const redacted: DiagnosticRecordDetail = {};
  for (const [key, value] of Object.entries(detail)) {
    if (REDACTED_DETAIL_KEYS.has(key)) {
      continue;
    }
    if (isDiagnosticScalar(value)) {
      redacted[key] = value;
    }
  }
  return redacted;
}

function normalizeDroppedCount(droppedCount: number | undefined): number {
  if (typeof droppedCount !== "number" || !Number.isFinite(droppedCount)) {
    return 0;
  }
  return Math.max(0, Math.trunc(droppedCount));
}

function isDiagnosticScalar(value: unknown): value is DiagnosticScalar {
  return (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  );
}
