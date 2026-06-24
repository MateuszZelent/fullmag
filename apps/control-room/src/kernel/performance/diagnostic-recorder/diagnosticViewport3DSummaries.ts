import type {
  DiagnosticAnyRecord,
  DiagnosticRecord,
  DiagnosticScalar,
  DiagnosticViewport3DBuildLaneSummary,
  DiagnosticViewport3DBuildRecord,
  DiagnosticViewport3DBuildSummary,
  DiagnosticViewport3DVisibleRevisionSummary,
  DiagnosticViewport3DVisibleRevisionTarget,
} from "./diagnosticRecorderTypes";

const VIEWPORT_3D_BUILD_ENGINE_PREFIX = "fullmag.viewport3d.build-engine.";
const MAX_VISIBLE_REVISION_TARGETS = 80;

export function buildDiagnosticViewport3DBuildSummary(
  streams: {
    readonly performance: readonly DiagnosticRecord[];
    readonly viewport3dBuild: readonly DiagnosticViewport3DBuildRecord[];
  },
): DiagnosticViewport3DBuildSummary {
  const byLane = new Map<
    string,
    Omit<DiagnosticViewport3DBuildLaneSummary, "fallbackReasons"> & {
      fallbackReasons: Set<string>;
    }
  >();

  for (const record of viewport3DBuildRecords(streams)) {
    const lane =
      stringValue(record, "buildLane") ??
      (record.name.startsWith(VIEWPORT_3D_BUILD_ENGINE_PREFIX)
        ? record.name.slice(VIEWPORT_3D_BUILD_ENGINE_PREFIX.length)
        : "unknown");
    const summary = ensureViewport3DBuildLaneSummary(byLane, lane);
    const state =
      stringValue(record, "buildState") ?? stringValue(record, "state");
    const fallbackReason = stringValue(record, "fallbackReason");

    summary.jobs += 1;
    summary.aborted += state === "aborted" ? 1 : 0;
    summary.failed += state === "failed" ? 1 : 0;
    summary.obsoleteDropped += booleanValue(record, "droppedBecauseObsolete")
      ? 1
      : 0;
    summary.fallbackCount += fallbackReason ? 1 : 0;
    if (fallbackReason) summary.fallbackReasons.add(fallbackReason);
    summary.queueWaitMaxMs = Math.max(
      summary.queueWaitMaxMs,
      numberValue(record, "queueWaitMs"),
    );
    summary.workerComputeMaxMs = Math.max(
      summary.workerComputeMaxMs,
      numberValue(record, "workerComputeMs"),
    );
    summary.transferMaxMs = Math.max(
      summary.transferMaxMs,
      numberValue(record, "transferMs"),
    );
    summary.mainAdoptMaxMs = Math.max(
      summary.mainAdoptMaxMs,
      numberValue(record, "mainAdoptMs"),
    );
    summary.mainUploadMaxMs = Math.max(
      summary.mainUploadMaxMs,
      numberValue(record, "mainUploadMs"),
    );
    summary.totalWallMaxMs = Math.max(
      summary.totalWallMaxMs,
      record.durationMs ?? numberValue(record, "totalWallMs"),
    );
    summary.inputBytes += numberValue(record, "inputBytes");
    summary.outputBytes += numberValue(record, "outputBytes");
    summary.itemCount += numberValue(record, "itemCount");
  }

  const lanes = Array.from(byLane.values())
    .map((summary) => ({
      ...summary,
      fallbackReasons: Array.from(summary.fallbackReasons).sort(),
    }))
    .toSorted((left, right) => right.totalWallMaxMs - left.totalWallMaxMs);

  return {
    lanes,
    totalJobs: lanes.reduce((total, lane) => total + lane.jobs, 0),
  };
}

export function buildDiagnosticViewport3DVisibleRevisionSummary(streams: {
  readonly performance: readonly DiagnosticRecord[];
  readonly timeline: readonly DiagnosticRecord[];
  readonly viewport3d: readonly DiagnosticRecord[];
  readonly viewport3dBuild: readonly DiagnosticViewport3DBuildRecord[];
}): DiagnosticViewport3DVisibleRevisionSummary {
  const summary: DiagnosticViewport3DVisibleRevisionSummary = {
    fieldRevision: null,
    invalidSuppressedTargets: [],
    staleCompatibleTargets: [],
    stalePhysicalTargets: [],
    targetVisualizationRevision: null,
    topologyRevision: null,
  };

  for (const record of allViewport3DRevisionRecords(streams)) {
    summary.topologyRevision =
      stringValue(record, "topologyRevision") ?? summary.topologyRevision;
    summary.fieldRevision =
      stringValue(record, "fieldRevision") ?? summary.fieldRevision;
    summary.targetVisualizationRevision =
      stringValue(record, "targetVisualizationRevision") ??
      summary.targetVisualizationRevision;

    const visibleState = stringValue(record, "visibleState");
    if (!visibleState) continue;

    const target = visibleRevisionTarget(record);
    if (visibleState === "stale-physical") {
      pushVisibleRevisionTarget(summary.stalePhysicalTargets, target);
    } else if (visibleState === "stale-compatible") {
      pushVisibleRevisionTarget(summary.staleCompatibleTargets, target);
    } else if (
      visibleState === "invalid" ||
      visibleState === "invalid-suppressed"
    ) {
      pushVisibleRevisionTarget(summary.invalidSuppressedTargets, target);
    }
  }

  return summary;
}

function viewport3DBuildRecords(streams: {
  readonly performance: readonly DiagnosticRecord[];
  readonly viewport3dBuild: readonly DiagnosticViewport3DBuildRecord[];
}): readonly DiagnosticRecord[] {
  return [
    ...streams.viewport3dBuild,
    ...streams.performance.filter((record) =>
      record.name.startsWith(VIEWPORT_3D_BUILD_ENGINE_PREFIX),
    ),
  ];
}

export function numberValue(
  record: DiagnosticAnyRecord,
  key: string,
): number {
  const direct = (record as unknown as Record<string, unknown>)[key];
  if (typeof direct === "number" && Number.isFinite(direct)) return direct;
  const detail = record.detail[key];
  return typeof detail === "number" && Number.isFinite(detail) ? detail : 0;
}

export function stringValue(
  record: DiagnosticAnyRecord,
  key: string,
): string | null {
  const direct = (record as unknown as Record<string, unknown>)[key];
  if (typeof direct === "string" && direct.length > 0) return direct;
  const detail = record.detail[key];
  return typeof detail === "string" && detail.length > 0 ? detail : null;
}

function booleanValue(record: DiagnosticAnyRecord, key: string): boolean {
  const direct = (record as unknown as Record<string, unknown>)[key];
  if (typeof direct === "boolean") return direct;
  return record.detail[key] === true;
}

function ensureViewport3DBuildLaneSummary(
  byLane: Map<
    string,
    Omit<DiagnosticViewport3DBuildLaneSummary, "fallbackReasons"> & {
      fallbackReasons: Set<string>;
    }
  >,
  lane: string,
): Omit<DiagnosticViewport3DBuildLaneSummary, "fallbackReasons"> & {
  fallbackReasons: Set<string>;
} {
  const existing = byLane.get(lane);
  if (existing) return existing;
  const summary = {
    aborted: 0,
    failed: 0,
    fallbackCount: 0,
    fallbackReasons: new Set<string>(),
    inputBytes: 0,
    itemCount: 0,
    jobs: 0,
    lane,
    mainAdoptMaxMs: 0,
    mainUploadMaxMs: 0,
    obsoleteDropped: 0,
    outputBytes: 0,
    queueWaitMaxMs: 0,
    totalWallMaxMs: 0,
    transferMaxMs: 0,
    workerComputeMaxMs: 0,
  };
  byLane.set(lane, summary);
  return summary;
}

function allViewport3DRevisionRecords(streams: {
  readonly performance: readonly DiagnosticRecord[];
  readonly timeline: readonly DiagnosticRecord[];
  readonly viewport3d: readonly DiagnosticRecord[];
  readonly viewport3dBuild: readonly DiagnosticViewport3DBuildRecord[];
}): readonly DiagnosticRecord[] {
  return [
    ...streams.viewport3dBuild,
    ...streams.viewport3d,
    ...streams.performance,
    ...streams.timeline,
  ];
}

function visibleRevisionTarget(
  record: DiagnosticAnyRecord,
): DiagnosticViewport3DVisibleRevisionTarget {
  return {
    displayedRevision: stringValue(record, "displayedRevision"),
    lane: stringValue(record, "buildLane"),
    targetKey: stringValue(record, "targetKey"),
    targetRevision: stringValue(record, "targetRevision"),
  };
}

function pushVisibleRevisionTarget(
  targets: DiagnosticViewport3DVisibleRevisionTarget[],
  target: DiagnosticViewport3DVisibleRevisionTarget,
): void {
  if (targets.length >= MAX_VISIBLE_REVISION_TARGETS) return;
  const key = visibleRevisionTargetKey(target);
  if (targets.some((existing) => visibleRevisionTargetKey(existing) === key)) {
    return;
  }
  targets.push(target);
}

function visibleRevisionTargetKey(
  target: DiagnosticViewport3DVisibleRevisionTarget,
): string {
  return [
    target.lane,
    target.targetKey,
    target.displayedRevision,
    target.targetRevision,
  ]
    .map((value: DiagnosticScalar) => value ?? "null")
    .join(":");
}
