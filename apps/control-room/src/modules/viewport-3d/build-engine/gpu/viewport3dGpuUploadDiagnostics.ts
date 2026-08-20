import type { Viewport3DGpuUploadDiagnosticRecord } from "./viewport3dGpuUploadTypes";
import type {
  DiagnosticRecordDetail,
  DiagnosticRecordSeverity,
  DiagnosticViewport3DBuildRecord,
} from "@/kernel/performance/diagnostic-recorder/diagnosticRecorderTypes";
import { recordVisualizationDebugPerformanceMetric } from "@/kernel/performance/visualizationDebugPerformanceProbe";

type Viewport3DGpuUploadDiagnosticListener = (
  record: Viewport3DGpuUploadDiagnosticRecord,
) => void;

const listeners = new Set<Viewport3DGpuUploadDiagnosticListener>();

export function recordViewport3DGpuUploadDiagnostic(
  record: Viewport3DGpuUploadDiagnosticRecord,
): void {
  if (record.status === "ready") {
    recordVisualizationDebugPerformanceMetric("gpuUploads");
    recordVisualizationDebugPerformanceMetric(
      "gpuUploadBytes",
      record.uploadBytes,
    );
    if (record.lane === "topology-index") {
      recordVisualizationDebugPerformanceMetric("topologyUploads");
    }
  }
  for (const listener of listeners) {
    try {
      listener(record);
    } catch {
      // One diagnostics consumer must not suppress other upload diagnostics.
    }
  }
}

export function subscribeViewport3DGpuUploadDiagnostics(
  listener: Viewport3DGpuUploadDiagnosticListener,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function createDiagnosticRecordFromViewport3DGpuUploadDiagnostic(
  record: Viewport3DGpuUploadDiagnosticRecord,
): DiagnosticViewport3DBuildRecord {
  return {
    buildKey: record.key,
    buildLane: `${record.lane}-upload`,
    buildState: record.status,
    byteLength: record.uploadBytes,
    displayedRevision: null,
    detail: buildDiagnosticDetail(record),
    droppedBecauseObsolete: record.aborted,
    droppedCount: 0,
    durationMs: record.maxFrameUploadMs,
    fallbackReason: null,
    id: "",
    inputBytes: record.uploadBytes,
    itemCount: record.uploadChunks,
    kind: "viewport-3d-build-job",
    lane: "viewport-3d",
    mainAdoptMs: 0,
    mainUploadMs: record.maxFrameUploadMs,
    name: `fullmag.viewport3d.gpu-upload.${record.lane}`,
    outputBytes: record.uploadBytes,
    queueWaitMs: 0,
    revisionSummary: [
      `target=${record.targetRevision ?? "unknown"}`,
      `frames=${record.uploadFrames}`,
      `chunks=${record.uploadChunks}`,
      `bytes=${record.uploadBytes}`,
    ].join(" "),
    severity: buildDiagnosticSeverity(record),
    startTimeMs: record.queuedAtMs,
    targetRevision: record.targetRevision,
    timestampMs: record.completedAtMs,
    transferMs: 0,
    visibleState: record.status === "ready" ? "ready-current" : null,
    workerComputeMs: 0,
  };
}

function buildDiagnosticDetail(
  record: Viewport3DGpuUploadDiagnosticRecord,
): DiagnosticRecordDetail {
  return {
    aborted: record.aborted,
    budgetExceeded: record.budgetExceeded,
    buildKey: record.key,
    buildLane: `${record.lane}-upload`,
    completedAtMs: record.completedAtMs,
    error: record.error,
    mainUploadMs: record.maxFrameUploadMs,
    maxChunkMs: record.maxChunkMs,
    maxFrameUploadMs: record.maxFrameUploadMs,
    queuedAtMs: record.queuedAtMs,
    state: record.status,
    status: record.status,
    targetRevision: record.targetRevision,
    totalMainUploadMs: record.mainUploadMs,
    totalWallMs: record.totalWallMs,
    uploadBytes: record.uploadBytes,
    uploadChunks: record.uploadChunks,
    uploadFrames: record.uploadFrames,
  };
}

function buildDiagnosticSeverity(
  record: Viewport3DGpuUploadDiagnosticRecord,
): DiagnosticRecordSeverity {
  if (record.status === "failed") return "critical";
  if (record.maxFrameUploadMs >= 50) return "critical";
  if (record.budgetExceeded || record.maxFrameUploadMs >= 16) return "warning";
  return "info";
}
