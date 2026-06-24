import type {
  DiagnosticRecordDetail,
  DiagnosticRecordSeverity,
  DiagnosticViewport3DBuildRecord,
} from "@/kernel/performance/diagnostic-recorder/diagnosticRecorderTypes";

import type { Viewport3DBuildDiagnosticRecord } from "./viewport3dBuildEngineTypes";

type Viewport3DBuildDiagnosticListener = (
  record: Viewport3DBuildDiagnosticRecord,
) => void;

const listeners = new Set<Viewport3DBuildDiagnosticListener>();

export function createDiagnosticRecordFromViewport3DBuildDiagnostic(
  record: Viewport3DBuildDiagnosticRecord,
): DiagnosticViewport3DBuildRecord {
  return {
    buildKey: record.key,
    buildLane: record.lane,
    buildState: record.state,
    byteLength: record.outputBytes,
    displayedRevision: null,
    detail: buildDiagnosticDetail(record),
    droppedBecauseObsolete: record.droppedBecauseObsolete,
    droppedCount: 0,
    durationMs: record.totalWallMs,
    fallbackReason: record.fallbackReason,
    id: "",
    inputBytes: record.inputBytes,
    itemCount: record.itemCount,
    kind: "viewport-3d-build-job",
    lane: "viewport-3d",
    mainAdoptMs: record.mainAdoptMs,
    mainUploadMs: record.mainUploadMs,
    name: `fullmag.viewport3d.build-engine.${record.lane}`,
    outputBytes: record.outputBytes,
    queueWaitMs: record.queueWaitMs,
    revisionSummary: record.revisionSummary,
    severity: buildDiagnosticSeverity(record),
    startTimeMs: record.queuedAtMs,
    targetRevision: null,
    timestampMs: record.finishedAtMs,
    transferMs: record.transferMs,
    visibleState: null,
    workerComputeMs: record.workerComputeMs,
  };
}

export function recordViewport3DBuildDiagnostic(
  record: Viewport3DBuildDiagnosticRecord,
): void {
  for (const listener of listeners) {
    listener(record);
  }
}

export function subscribeViewport3DBuildDiagnostics(
  listener: Viewport3DBuildDiagnosticListener,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function buildDiagnosticDetail(
  record: Viewport3DBuildDiagnosticRecord,
): DiagnosticRecordDetail {
  return {
    abortedAtMs: record.abortedAtMs,
    buildKey: record.key,
    buildLane: record.lane,
    droppedBecauseObsolete: record.droppedBecauseObsolete,
    fallbackReason: record.fallbackReason,
    inputBytes: record.inputBytes,
    itemCount: record.itemCount,
    mainAdoptMs: record.mainAdoptMs,
    mainUploadMs: record.mainUploadMs,
    outputBytes: record.outputBytes,
    queueWaitMs: record.queueWaitMs,
    revisionSummary: record.revisionSummary,
    startedAtMs: record.startedAtMs,
    state: record.state,
    transferMs: record.transferMs,
    workerComputeMs: record.workerComputeMs,
  };
}

function buildDiagnosticSeverity(
  record: Viewport3DBuildDiagnosticRecord,
): DiagnosticRecordSeverity {
  if (record.state === "failed") return "critical";
  if (record.totalWallMs >= 5_000) return "critical";
  if (record.fallbackReason) return "warning";
  if (record.state === "aborted" && !record.droppedBecauseObsolete) {
    return "warning";
  }
  if (record.totalWallMs >= 1_000) return "warning";
  return "info";
}
