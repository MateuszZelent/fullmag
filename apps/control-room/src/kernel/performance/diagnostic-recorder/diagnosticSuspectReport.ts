import {
  DIAGNOSTIC_EVENT_NAMES,
  type DiagnosticAnyRecord,
  type DiagnosticArtifactV1,
  type DiagnosticRecord,
  type DiagnosticRecordDetail,
  type DiagnosticSuspect,
  type DiagnosticSuspectReport,
} from "./diagnosticRecorderTypes";

type DiagnosticArtifactForReport = Omit<DiagnosticArtifactV1, "suspectReport">;

export function buildDiagnosticSuspectReport(
  artifact: DiagnosticArtifactForReport,
  now: () => number = Date.now,
): DiagnosticSuspectReport {
  const suspects = [
    ...topLongestRecords(artifact.streams.performance, 20),
    ...topLongestRecords(artifact.streams.viewport3d, 20),
    ...topSlowRequests(artifact.streams.requests, 20),
    ...repeatedRequests(artifact.streams.requests),
    ...memorySuspects(artifact.streams.memory),
    ...unreleasedViewportResources(artifact.streams.viewport3d),
    ...consoleSuspects(artifact.streams.console),
    ...droppedRecordSuspects(allRecords(artifact.streams), artifact.summary.droppedCount),
  ];

  return {
    generatedAtIso: new Date(now()).toISOString(),
    suspects: suspects.slice(0, 80),
    text: formatSuspectReportText(artifact, suspects),
  };
}

function topLongestRecords(
  records: readonly DiagnosticRecord[],
  limit: number,
): DiagnosticSuspect[] {
  return records
    .filter((record) => typeof record.durationMs === "number")
    .toSorted((left, right) => (right.durationMs ?? 0) - (left.durationMs ?? 0))
    .slice(0, limit)
    .filter((record) => (record.durationMs ?? 0) >= 50)
    .map((record) => ({
      detail: {
        durationMs: record.durationMs,
        name: record.name,
      },
      id: `slow:${record.id || record.name}`,
      lane: record.lane,
      reason: `slow ${record.lane} record: ${record.name} (${record.durationMs} ms)`,
      severity: (record.durationMs ?? 0) >= 100 ? "critical" : "warning",
    }));
}

function topSlowRequests(
  records: DiagnosticArtifactV1["streams"]["requests"],
  limit: number,
): DiagnosticSuspect[] {
  return records
    .filter((record) => typeof record.durationMs === "number")
    .toSorted((left, right) => (right.durationMs ?? 0) - (left.durationMs ?? 0))
    .slice(0, limit)
    .filter((record) => (record.durationMs ?? 0) >= 100)
    .map((record) => ({
      detail: {
        durationMs: record.durationMs,
        method: record.method,
        path: record.path,
        status: record.status,
      },
      id: `request-slow:${record.method}:${record.path}`,
      lane: "api",
      reason: `slow request: ${record.method} ${record.path} (${record.durationMs} ms)`,
      severity: (record.durationMs ?? 0) >= 1_000 ? "critical" : "warning",
    }));
}

function repeatedRequests(
  records: DiagnosticArtifactV1["streams"]["requests"],
): DiagnosticSuspect[] {
  const counts = new Map<string, number>();
  for (const record of records) {
    const key = record.resourceKey ?? `${record.method} ${record.path}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .filter(([, count]) => count >= 3)
    .toSorted((left, right) => right[1] - left[1])
    .map(([resourceKey, count]) => ({
      detail: { count, resourceKey },
      id: `request-repeat:${resourceKey}`,
      lane: "api",
      reason: `repeated request/resource key: ${resourceKey} (${count} samples)`,
      severity: count >= 10 ? "critical" : "warning",
    }));
}

function memorySuspects(
  records: DiagnosticArtifactV1["streams"]["memory"],
): DiagnosticSuspect[] {
  return records
    .filter(
      (record) =>
        record.name === DIAGNOSTIC_EVENT_NAMES.leakCheck &&
        (record.severity === "critical" || record.severity === "warning"),
    )
    .map((record) => ({
      detail: record.detail,
      id: `memory:${record.id || record.timestampMs}`,
      lane: "memory",
      reason: `memory leak check reported ${String(record.detail.classification ?? record.severity)}`,
      severity: record.severity,
    }));
}

function unreleasedViewportResources(
  records: DiagnosticArtifactV1["streams"]["viewport3d"],
): DiagnosticSuspect[] {
  const tracked = new Map<string, DiagnosticRecordDetail>();
  for (const record of records) {
    const resourceId = record.detail.resourceId;
    if (typeof resourceId !== "string") continue;
    if (record.name === DIAGNOSTIC_EVENT_NAMES.viewport3DResourceTracked) {
      tracked.set(resourceId, record.detail);
    }
    if (record.name === DIAGNOSTIC_EVENT_NAMES.viewport3DResourceReleased) {
      tracked.delete(resourceId);
    }
  }
  return Array.from(tracked.entries()).map(([resourceId, detail]) => ({
    detail,
    id: `viewport3d-unreleased:${resourceId}`,
    lane: "viewport-3d",
    reason: `unreleased viewport 3D resource: ${resourceId}`,
    severity: "critical",
  }));
}

function consoleSuspects(
  records: DiagnosticArtifactV1["streams"]["console"],
): DiagnosticSuspect[] {
  return records
    .filter((record) => record.level === "error")
    .map((record) => ({
      detail: {
        message: record.message.slice(0, 240),
        source: record.source,
      },
      id: `console:${record.id || record.timestampMs}`,
      lane: "console",
      reason: `console/page error: ${record.message.slice(0, 160)}`,
      severity: "critical",
    }));
}

function droppedRecordSuspects(
  records: readonly DiagnosticAnyRecord[],
  summaryDroppedCount: number,
): DiagnosticSuspect[] {
  const droppedCount =
    summaryDroppedCount +
    records.reduce((total, record) => total + record.droppedCount, 0);
  if (droppedCount <= 0) return [];
  return [
    {
      detail: { droppedCount },
      id: "diagnostics:dropped-records",
      lane: "startup",
      reason: `diagnostic recorder dropped ${droppedCount} records under backpressure`,
      severity: "warning",
    },
  ];
}

function formatSuspectReportText(
  artifact: DiagnosticArtifactForReport,
  suspects: readonly DiagnosticSuspect[],
): string {
  const lines = [
    "# Fullmag Diagnostic Suspect Report",
    "",
    `Scenario: ${artifact.manifest.scenario}`,
    `Profile: ${artifact.manifest.profile}`,
    `Records: ${artifact.summary.recordCount}`,
    `Warnings: ${artifact.summary.warningCount}`,
    `Critical: ${artifact.summary.criticalCount}`,
    `Dropped: ${artifact.summary.droppedCount}`,
    "",
    "## Top Suspects",
  ];
  if (suspects.length === 0) {
    lines.push("No suspects detected.");
  } else {
    for (const [index, suspect] of suspects.slice(0, 20).entries()) {
      lines.push(
        `${index + 1}. [${suspect.severity}] ${suspect.reason} (${suspect.lane})`,
      );
    }
  }
  return lines.join("\n");
}

function allRecords(
  streams: DiagnosticArtifactV1["streams"],
): DiagnosticAnyRecord[] {
  return Object.values(streams).flat() as DiagnosticAnyRecord[];
}
