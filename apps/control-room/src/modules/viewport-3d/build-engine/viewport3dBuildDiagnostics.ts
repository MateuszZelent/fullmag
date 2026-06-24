import type {
  DiagnosticRecord,
  DiagnosticRecordDetail,
  DiagnosticRecordSeverity,
} from "@/kernel/performance/diagnostic-recorder/diagnosticRecorderTypes";

import type { Viewport3DBuildDiagnosticRecord } from "./viewport3dBuildEngineTypes";

type Viewport3DBuildDiagnosticListener = (
  record: Viewport3DBuildDiagnosticRecord,
) => void;

const listeners = new Set<Viewport3DBuildDiagnosticListener>();

export function createDiagnosticRecordFromViewport3DBuildDiagnostic(
  record: Viewport3DBuildDiagnosticRecord,
): DiagnosticRecord {
  return {
    byteLength: record.outputBytes,
    detail: buildDiagnosticDetail(record),
    droppedCount: 0,
    durationMs: record.totalWallMs,
    id: "",
    kind: "measure",
    lane: "viewport-3d",
    name: `fullmag.viewport3d.build-engine.${record.lane}`,
    severity: buildDiagnosticSeverity(record),
    startTimeMs: record.queuedAtMs,
    timestampMs: record.finishedAtMs,
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
