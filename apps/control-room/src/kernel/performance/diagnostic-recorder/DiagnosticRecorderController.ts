import type { RequestDiagnosticsController } from "@/kernel/api/RequestDiagnosticsController";
import type { RequestDiagnosticEntry } from "@/kernel/api/RequestDiagnosticsController";

import {
  DIAGNOSTIC_ARTIFACT_VERSION,
  DIAGNOSTIC_EVENT_NAMES,
  type DiagnosticAnyRecord,
  type DiagnosticArtifactV1,
  type DiagnosticManifest,
  type DiagnosticRecord,
  type DiagnosticRecordDetail,
  type DiagnosticRecordLane,
  type DiagnosticRecordSeverity,
  type DiagnosticRequestRecord,
  type DiagnosticRecorderProfile,
  type DiagnosticSummary,
  redactDiagnosticDetail,
} from "./diagnosticRecorderTypes";
import {
  DEFAULT_DIAGNOSTIC_RECORDER_MAX_BYTES,
  DEFAULT_DIAGNOSTIC_RECORDER_MAX_RECORDS,
  DEFAULT_DIAGNOSTIC_RECORDER_PROFILE,
  DEFAULT_DIAGNOSTIC_RECORDER_SCENARIO,
  type DiagnosticRecorderConfig,
} from "./diagnosticRecorderConfig";
import type { EarlyDiagnosticRecorderGlobal } from "./earlyDiagnosticRecorder";
import { buildDiagnosticArtifactV1 } from "./diagnosticArtifactExport";

type DiagnosticRecorderListener = () => void;

export interface DiagnosticRecorderSnapshot {
  droppedCount: number;
  estimatedByteLength: number;
  maxBytes: number;
  maxRecords: number;
  profile: DiagnosticRecorderProfile;
  recording: boolean;
  scenario: string;
  streams: DiagnosticArtifactV1["streams"];
  summary: DiagnosticSummary;
  version: number;
}

export interface DiagnosticRecorderControllerOptions {
  config?: Partial<DiagnosticRecorderConfig>;
  diagnostics?: RequestDiagnosticsController;
  earlyRecorder?: EarlyDiagnosticRecorderGlobal | null;
  now?: () => number;
}

type DiagnosticStreamName = keyof DiagnosticArtifactV1["streams"];

const EMPTY_STREAMS: DiagnosticArtifactV1["streams"] = {
  browserMetrics: [],
  console: [],
  memory: [],
  performance: [],
  react: [],
  requests: [],
  resources: [],
  timeline: [],
  viewport3d: [],
};

export class DiagnosticRecorderController {
  private readonly listeners = new Set<DiagnosticRecorderListener>();
  private readonly maxBytes: number;
  private readonly maxRecords: number;
  private readonly now: () => number;
  private droppedCount = 0;
  private estimatedByteLength = 0;
  private notificationQueued = false;
  private profile: DiagnosticRecorderProfile;
  private recording: boolean;
  private scenario: string;
  private sequence = 0;
  private snapshotCache: DiagnosticRecorderSnapshot | null = null;
  private streams: DiagnosticArtifactV1["streams"] = cloneEmptyStreams();
  private version = 0;

  constructor(private readonly options: DiagnosticRecorderControllerOptions = {}) {
    const config = options.config ?? {};
    this.maxBytes =
      config.maxBytes ?? DEFAULT_DIAGNOSTIC_RECORDER_MAX_BYTES;
    this.maxRecords =
      config.maxRecords ?? DEFAULT_DIAGNOSTIC_RECORDER_MAX_RECORDS;
    this.now = options.now ?? Date.now;
    this.profile = config.profile ?? DEFAULT_DIAGNOSTIC_RECORDER_PROFILE;
    this.recording = config.enabled === true;
    this.scenario = config.scenario ?? DEFAULT_DIAGNOSTIC_RECORDER_SCENARIO;
    options.diagnostics?.subscribeRecords?.((entry) => {
      const record = requestDiagnosticEntryToRecord(entry);
      if (record) this.record(record);
    });
  }

  clear(): void {
    this.streams = cloneEmptyStreams();
    this.droppedCount = 0;
    this.estimatedByteLength = 0;
    this.schedulePublish();
  }

  drainEarlyRecorder(): number {
    const earlyRecorder = this.options.earlyRecorder ?? defaultEarlyRecorder();
    if (!earlyRecorder) return 0;
    const records = earlyRecorder.drain();
    for (const record of records) {
      this.record(record);
    }
    return records.length;
  }

  exportArtifact(): DiagnosticArtifactV1 {
    return buildDiagnosticArtifactV1(
      this.getSnapshot(),
      this.buildManifest(),
      this.now,
    );
  }

  getSnapshot(): DiagnosticRecorderSnapshot {
    if (this.snapshotCache?.version === this.version) {
      return this.snapshotCache;
    }
    const streams = cloneStreams(this.streams);
    this.snapshotCache = {
      droppedCount: this.droppedCount,
      estimatedByteLength: this.estimatedByteLength,
      maxBytes: this.maxBytes,
      maxRecords: this.maxRecords,
      profile: this.profile,
      recording: this.recording,
      scenario: this.scenario,
      streams,
      summary: buildSummary(streams, this.droppedCount),
      version: this.version,
    };
    return this.snapshotCache;
  }

  getVersion(): number {
    return this.version;
  }

  mark(
    name: string,
    detail: Record<string, unknown> = {},
    lane: DiagnosticRecordLane = "startup",
  ): void {
    this.record({
      byteLength: null,
      detail: redactDiagnosticDetail(detail),
      droppedCount: 0,
      durationMs: null,
      id: this.nextId(),
      kind: "mark",
      lane,
      name,
      severity: "info",
      startTimeMs: null,
      timestampMs: this.now(),
    });
  }

  record(record: DiagnosticAnyRecord): void {
    if (!this.recording && record.severity !== "critical") {
      return;
    }

    const normalized = normalizeRecord(record, () => this.nextId(), this.now);
    this.appendToStream(resolveStreamName(normalized), normalized);
    this.mirrorToLegacyDiagnostics(normalized);
    this.schedulePublish();
  }

  start(profile: DiagnosticRecorderProfile = this.profile): void {
    this.profile = profile;
    this.recording = true;
    this.mark("diagnostic-recorder.started", { profile }, "scenario");
  }

  stop(): void {
    if (!this.recording) return;
    this.mark("diagnostic-recorder.stopped", { profile: this.profile }, "scenario");
    this.recording = false;
    this.schedulePublish();
  }

  subscribe(listener: DiagnosticRecorderListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private appendToStream(
    streamName: DiagnosticStreamName,
    record: DiagnosticAnyRecord,
  ): void {
    const stream = this.streams[streamName] as DiagnosticAnyRecord[];
    stream.push(record);
    this.estimatedByteLength += estimateRecordBytes(record);
    this.evictUntilWithinBudget();
  }

  private buildManifest(): DiagnosticManifest {
    return {
      artifactVersion: DIAGNOSTIC_ARTIFACT_VERSION,
      branch: null,
      browserName: null,
      browserVersion: null,
      commit: null,
      createdAtIso: new Date(this.now()).toISOString(),
      profile: this.profile,
      scenario: this.scenario,
      url: null,
    };
  }

  private evictUntilWithinBudget(): void {
    while (
      this.totalRecordCount() > this.maxRecords ||
      this.estimatedByteLength > this.maxBytes
    ) {
      if (!this.evictOneNonCriticalRecord()) {
        break;
      }
    }
  }

  private evictOneNonCriticalRecord(): boolean {
    for (const stream of Object.values(this.streams) as DiagnosticAnyRecord[][]) {
      const index = stream.findIndex((record) => record.severity !== "critical");
      if (index >= 0) {
        const [removed] = stream.splice(index, 1);
        this.estimatedByteLength = Math.max(
          0,
          this.estimatedByteLength - estimateRecordBytes(removed),
        );
        this.droppedCount += 1;
        return true;
      }
    }
    return false;
  }

  private mirrorToLegacyDiagnostics(record: DiagnosticRecord): void {
    this.options.diagnostics?.record({
      byteLength: record.byteLength,
      channel: "performance",
      contentType: null,
      detail: serializeDetail(record.detail),
      direction: "rx",
      durationMs: record.durationMs,
      messageType: record.kind,
      method: "DIAG",
      outcome: "ok",
      path: `fullmag.diagnostic.${record.name}`,
      requestId: record.id,
      status: null,
      timestampMs: record.timestampMs,
    });
  }

  private nextId(): string {
    return `diagnostic-${this.now()}-${this.sequence++}`;
  }

  private schedulePublish(): void {
    this.snapshotCache = null;
    if (this.notificationQueued) return;
    this.notificationQueued = true;
    queueMicrotask(() => {
      this.notificationQueued = false;
      this.version += 1;
      for (const listener of this.listeners) {
        listener();
      }
    });
  }

  private totalRecordCount(): number {
    return Object.values(this.streams).reduce(
      (total, stream) => total + stream.length,
      0,
    );
  }
}

function normalizeRecord(
  record: DiagnosticAnyRecord,
  id: () => string,
  now: () => number,
): DiagnosticAnyRecord {
  return {
    ...record,
    detail: redactDiagnosticDetail(record.detail),
    droppedCount: Math.max(0, record.droppedCount ?? 0),
    id: record.id || id(),
    timestampMs: Number.isFinite(record.timestampMs) ? record.timestampMs : now(),
  } as DiagnosticAnyRecord;
}

function resolveStreamName(record: DiagnosticAnyRecord): DiagnosticStreamName {
  if ("metricName" in record) return "browserMetrics";
  if ("level" in record) return "console";
  if ("usedJSHeapBytes" in record) return "memory";
  if ("componentId" in record) return "react";
  if ("method" in record && "path" in record) return "requests";
  if ("cacheAction" in record) return "resources";
  if ("geometries" in record || record.kind === "viewport-frame-window") {
    return "viewport3d";
  }
  if (record.kind === "performance" || record.kind === "measure") {
    return "performance";
  }
  return "timeline";
}

function requestDiagnosticEntryToRecord(
  entry: RequestDiagnosticEntry,
): DiagnosticRecord | DiagnosticRequestRecord | null {
  if (entry.path.startsWith("fullmag.diagnostic.")) {
    return null;
  }
  if (entry.channel === "performance") {
    return performanceDiagnosticEntryToRecord(entry);
  }
  const { path, query } = splitPathAndQuery(entry.path);
  return {
    byteLength: entry.byteLength,
    contentType: entry.contentType,
    detail: redactDiagnosticDetail({
      channel: entry.channel,
      detail: sanitizeRequestDetail(entry.detail),
      direction: entry.direction,
      messageType: entry.messageType,
    }),
    droppedCount: 0,
    durationMs: entry.durationMs,
    etag: entry.etag ?? null,
    id: "",
    kind: "request",
    lane: "api",
    method: entry.method,
    name:
      entry.direction === "tx" || entry.outcome === "sent"
        ? DIAGNOSTIC_EVENT_NAMES.requestStarted
        : DIAGNOSTIC_EVENT_NAMES.requestFinished,
    outcome: entry.outcome,
    path,
    query,
    requestId: entry.requestId,
    resourceKey: entry.resourceKey ?? entry.path,
    severity: requestDiagnosticSeverity(entry),
    startTimeMs:
      typeof entry.durationMs === "number"
        ? Math.max(0, entry.timestampMs - entry.durationMs)
        : null,
    status: entry.status,
    timestampMs: entry.timestampMs,
  };
}

function performanceDiagnosticEntryToRecord(
  entry: RequestDiagnosticEntry,
): DiagnosticRecord {
  const detail = {
    ...parseDiagnosticDetail(entry.detail),
    bucket: classifyPerformanceBucket(entry.path),
    method: entry.method,
    messageType: entry.messageType,
  };
  return {
    byteLength: entry.byteLength ?? null,
    detail: redactDiagnosticDetail(detail),
    droppedCount: 0,
    durationMs: entry.durationMs,
    id: "",
    kind: entry.messageType ?? "performance",
    lane: classifyPerformanceLane(entry.path),
    name: entry.path,
    severity: performanceDiagnosticSeverity(entry.durationMs),
    startTimeMs:
      typeof entry.durationMs === "number"
        ? Math.max(0, entry.timestampMs - entry.durationMs)
        : null,
    timestampMs: entry.timestampMs,
  };
}

function parseDiagnosticDetail(detail: string | null): DiagnosticRecordDetail {
  if (!detail) return {};
  const parsed: DiagnosticRecordDetail = {};
  for (const part of detail.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const key = part.slice(0, separator).trim();
    const rawValue = part.slice(separator + 1).trim();
    if (!key) continue;
    parsed[key] = parseDiagnosticScalar(rawValue);
  }
  return parsed;
}

function parseDiagnosticScalar(value: string): string | number | boolean | null {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null" || value === "n/a") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && value.trim() !== "" ? numeric : value;
}

function classifyPerformanceLane(path: string): DiagnosticRecordLane {
  if (path.startsWith("fullmag.react.render.")) return "react";
  if (path.startsWith("fullmag.viewport3d.")) return "viewport-3d";
  if (path.startsWith("fullmag.api.requestBinaryResource.")) return "worker";
  if (path.startsWith("fullmag.browser.")) return "main-thread";
  if (path.includes("resource") || path.includes("ResourceCache")) {
    return "resource-cache";
  }
  return "startup";
}

function classifyPerformanceBucket(path: string): string {
  if (path.startsWith("fullmag.react.render.")) return "react-render";
  if (path.startsWith("fullmag.viewport3d.")) {
    if (/upload/i.test(path)) return "viewport-upload";
    return "viewport-build";
  }
  if (path.startsWith("fullmag.api.requestBinaryResource.")) {
    return "binary-decode";
  }
  if (path.includes("resource") || path.includes("ResourceCache")) {
    return "resource-cache";
  }
  if (path.startsWith("fullmag.browser.")) return "startup";
  return "unknown";
}

function performanceDiagnosticSeverity(
  durationMs: number | null,
): DiagnosticRecordSeverity {
  if (typeof durationMs !== "number") return "info";
  if (durationMs >= 100) return "critical";
  if (durationMs >= 50) return "warning";
  return "info";
}

function sanitizeRequestDetail(detail: string | null): string | null {
  if (!detail) return null;
  return /\b(authorization|body|cookie|responseBody|token)\b/i.test(detail)
    ? "[redacted]"
    : detail;
}

function requestDiagnosticSeverity(
  entry: RequestDiagnosticEntry,
): DiagnosticRecordSeverity {
  if (entry.outcome === "network-error" || entry.status === 0) return "critical";
  if (entry.outcome === "aborted" || entry.outcome === "error") return "warning";
  if (typeof entry.status === "number" && entry.status >= 500) return "warning";
  if (typeof entry.durationMs === "number" && entry.durationMs >= 1_000) {
    return "warning";
  }
  return "info";
}

function splitPathAndQuery(pathWithQuery: string): {
  path: string;
  query: string | null;
} {
  const queryStart = pathWithQuery.indexOf("?");
  if (queryStart < 0) {
    return { path: pathWithQuery, query: null };
  }
  return {
    path: pathWithQuery.slice(0, queryStart),
    query: pathWithQuery.slice(queryStart + 1) || null,
  };
}

function buildSummary(
  streams: DiagnosticArtifactV1["streams"],
  droppedCount: number,
): DiagnosticSummary {
  const records = allRecords(streams);
  return {
    criticalCount: records.filter((record) => record.severity === "critical").length,
    droppedCount,
    recordCount: records.length,
    slowestRecord: records
      .filter((record) => typeof record.durationMs === "number")
      .toSorted((left, right) => (right.durationMs ?? 0) - (left.durationMs ?? 0))[0] ?? null,
    warningCount: records.filter((record) => record.severity === "warning").length,
  };
}

function allRecords(streams: DiagnosticArtifactV1["streams"]): DiagnosticAnyRecord[] {
  return Object.values(streams).flat() as DiagnosticAnyRecord[];
}

function cloneEmptyStreams(): DiagnosticArtifactV1["streams"] {
  return cloneStreams(EMPTY_STREAMS);
}

function cloneStreams(
  streams: DiagnosticArtifactV1["streams"],
): DiagnosticArtifactV1["streams"] {
  return {
    browserMetrics: [...streams.browserMetrics],
    console: [...streams.console],
    memory: [...streams.memory],
    performance: [...streams.performance],
    react: [...streams.react],
    requests: [...streams.requests],
    resources: [...streams.resources],
    timeline: [...streams.timeline],
    viewport3d: [...streams.viewport3d],
  };
}

function estimateRecordBytes(record: DiagnosticAnyRecord): number {
  return JSON.stringify(record).length * 2;
}

function serializeDetail(detail: DiagnosticRecordDetail): string {
  return Object.entries(detail)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(";");
}

function defaultEarlyRecorder(): EarlyDiagnosticRecorderGlobal | null {
  if (typeof window === "undefined") {
    return null;
  }
  return (
    window as Window & {
      __FULLMAG_DIAGNOSTIC_RECORDER__?: EarlyDiagnosticRecorderGlobal;
    }
  ).__FULLMAG_DIAGNOSTIC_RECORDER__ ?? null;
}

export { DIAGNOSTIC_EVENT_NAMES };
