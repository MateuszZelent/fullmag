import {
  DIAGNOSTIC_EVENT_NAMES,
  type DiagnosticMemoryRecord,
  redactDiagnosticDetail,
} from "./diagnosticRecorderTypes";

export type DiagnosticLeakSnapshotKind =
  | "after-forced-gc"
  | "after-load"
  | "after-quantity-loop"
  | "after-tab-switch-loop"
  | "after-unmount"
  | "before";

export type DiagnosticLeakClassification =
  | "leak-confirmed"
  | "leak-suspected"
  | "ok"
  | "watch";

export interface DiagnosticLeakSnapshot {
  activeWorkers: number;
  dirtyFramesAfterIdle: number;
  jsHeapUsedBytes: number | null;
  kind: DiagnosticLeakSnapshotKind;
  moduleOwnedResourceCount: number;
  objectUrlCount: number;
  resourceCacheBytes: number;
  subscriptionCount: number;
  timestampMs: number;
  totalTrackedBytes: number;
  viewportCacheBytes: number;
  webglEstimatedBytes: number;
}

export interface DiagnosticLeakThresholds {
  jsHeapGrowthWarningBytes: number;
  trackedGrowthWatchBytes: number;
  webglGrowthWatchBytes: number;
}

export interface DiagnosticLeakComparison {
  after: DiagnosticLeakSnapshot;
  before: DiagnosticLeakSnapshot;
  classification: DiagnosticLeakClassification;
  deltas: {
    activeWorkers: number;
    jsHeapUsedBytes: number | null;
    objectUrlCount: number;
    resourceCacheBytes: number;
    subscriptionCount: number;
    totalTrackedBytes: number;
    viewportCacheBytes: number;
    webglEstimatedBytes: number;
  };
  reasons: string[];
}

export const DEFAULT_DIAGNOSTIC_LEAK_THRESHOLDS: DiagnosticLeakThresholds = {
  jsHeapGrowthWarningBytes: 25 * 1024 * 1024,
  trackedGrowthWatchBytes: 1 * 1024 * 1024,
  webglGrowthWatchBytes: 1 * 1024 * 1024,
};

export function compareDiagnosticLeakSnapshots(
  before: DiagnosticLeakSnapshot,
  after: DiagnosticLeakSnapshot,
  thresholds: DiagnosticLeakThresholds = DEFAULT_DIAGNOSTIC_LEAK_THRESHOLDS,
): DiagnosticLeakComparison {
  const deltas = {
    activeWorkers: after.activeWorkers - before.activeWorkers,
    jsHeapUsedBytes:
      before.jsHeapUsedBytes === null || after.jsHeapUsedBytes === null
        ? null
        : after.jsHeapUsedBytes - before.jsHeapUsedBytes,
    objectUrlCount: after.objectUrlCount - before.objectUrlCount,
    resourceCacheBytes: after.resourceCacheBytes - before.resourceCacheBytes,
    subscriptionCount: after.subscriptionCount - before.subscriptionCount,
    totalTrackedBytes: after.totalTrackedBytes - before.totalTrackedBytes,
    viewportCacheBytes: after.viewportCacheBytes - before.viewportCacheBytes,
    webglEstimatedBytes: after.webglEstimatedBytes - before.webglEstimatedBytes,
  };
  const reasons: string[] = [];
  let classification: DiagnosticLeakClassification = "ok";

  if (after.kind === "after-unmount" && after.moduleOwnedResourceCount > 0) {
    reasons.push("module-owned resources remain after unmount");
    classification = "leak-confirmed";
  }
  if (after.kind === "after-unmount" && after.webglEstimatedBytes > 0) {
    reasons.push("WebGL bytes remain after viewport unmount");
    classification = "leak-confirmed";
  }
  if (
    (after.kind === "after-tab-switch-loop" || after.kind === "after-unmount") &&
    after.subscriptionCount > 0
  ) {
    reasons.push("viewport subscriptions remain after leaving the viewport");
    classification = "leak-confirmed";
  }

  if (classification !== "leak-confirmed") {
    if (
      deltas.jsHeapUsedBytes !== null &&
      deltas.jsHeapUsedBytes >= thresholds.jsHeapGrowthWarningBytes
    ) {
      reasons.push("JS heap grew beyond the leak warning threshold");
      classification = "leak-suspected";
    }
    if (after.dirtyFramesAfterIdle > 0) {
      reasons.push("viewport produced dirty frames after idle");
      classification = "leak-suspected";
    }
  }

  if (classification === "ok" && watchGrowthDetected(deltas, thresholds)) {
    reasons.push("tracked memory grew but stayed below leak thresholds");
    classification = "watch";
  }

  return {
    after,
    before,
    classification,
    deltas,
    reasons,
  };
}

export function diagnosticLeakComparisonToRecord(
  comparison: DiagnosticLeakComparison,
): DiagnosticMemoryRecord {
  return {
    byteLength: comparison.after.totalTrackedBytes,
    detail: redactDiagnosticDetail({
      afterKind: comparison.after.kind,
      beforeKind: comparison.before.kind,
      classification: comparison.classification,
      dirtyFramesAfterIdle: comparison.after.dirtyFramesAfterIdle,
      jsHeapDeltaBytes: comparison.deltas.jsHeapUsedBytes,
      moduleOwnedResourceCount: comparison.after.moduleOwnedResourceCount,
      reasonCount: comparison.reasons.length,
      webglDeltaBytes: comparison.deltas.webglEstimatedBytes,
    }),
    droppedCount: 0,
    durationMs: Math.max(
      0,
      comparison.after.timestampMs - comparison.before.timestampMs,
    ),
    estimatedWebGLBytes: comparison.after.webglEstimatedBytes,
    id: "",
    jsHeapLimitBytes: null,
    kind: "memory",
    lane: "memory",
    name: DIAGNOSTIC_EVENT_NAMES.leakCheck,
    severity:
      comparison.classification === "leak-confirmed"
        ? "critical"
        : comparison.classification === "leak-suspected"
          ? "warning"
          : "info",
    startTimeMs: comparison.before.timestampMs,
    timestampMs: comparison.after.timestampMs,
    totalJSHeapBytes: null,
    trackedBytes: comparison.after.totalTrackedBytes,
    usedJSHeapBytes: comparison.after.jsHeapUsedBytes,
  };
}

function watchGrowthDetected(
  deltas: DiagnosticLeakComparison["deltas"],
  thresholds: DiagnosticLeakThresholds,
): boolean {
  return (
    deltas.activeWorkers > 0 ||
    deltas.objectUrlCount > 0 ||
    deltas.resourceCacheBytes > thresholds.trackedGrowthWatchBytes ||
    deltas.totalTrackedBytes > thresholds.trackedGrowthWatchBytes ||
    deltas.viewportCacheBytes > thresholds.trackedGrowthWatchBytes ||
    deltas.webglEstimatedBytes > thresholds.webglGrowthWatchBytes
  );
}
