import {
  DIAGNOSTIC_EVENT_NAMES,
  type DiagnosticAnyRecord,
  type DiagnosticArtifactV1,
  type DiagnosticRecord,
  type DiagnosticRecordDetail,
  type DiagnosticSuspect,
  type DiagnosticSuspectReport,
} from "./diagnosticRecorderTypes";
import {
  buildDiagnosticViewport3DVisibleRevisionSummary,
  numberValue,
  stringValue,
} from "./diagnosticViewport3DSummaries";

type DiagnosticArtifactForReport = Omit<DiagnosticArtifactV1, "suspectReport">;

export function buildDiagnosticSuspectReport(
  artifact: DiagnosticArtifactForReport,
  now: () => number = Date.now,
): DiagnosticSuspectReport {
  const suspects = [
    ...topLongestRecords(artifact.streams.performance, 20),
    ...topLongestRecords(artifact.streams.viewport3d, 20),
    ...viewport3DBuildPhaseSuspects(artifact.streams.viewport3dBuild),
    ...visibleRevisionSuspects(
      buildDiagnosticViewport3DVisibleRevisionSummary(artifact.streams),
    ),
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
  const candidates: DiagnosticRecord[] = [];
  for (const record of records) {
    if (typeof record.durationMs === "number" && record.durationMs >= 50) {
      candidates.push(record);
    }
  }

  const suspects: DiagnosticSuspect[] = [];
  const sorted = candidates.toSorted(
    (left, right) => (right.durationMs ?? 0) - (left.durationMs ?? 0),
  );
  for (const record of sorted.slice(0, limit)) {
    suspects.push({
      detail: {
        durationMs: record.durationMs,
        name: record.name,
        suspectCategory: classifyRecordSuspectCategory(record),
      },
      id: `slow:${record.id || record.name}`,
      lane: record.lane,
      reason: `slow ${record.lane} record: ${record.name} (${record.durationMs} ms)`,
      severity: (record.durationMs ?? 0) >= 100 ? "critical" : "warning",
    });
  }
  return suspects;
}

function topSlowRequests(
  records: DiagnosticArtifactV1["streams"]["requests"],
  limit: number,
): DiagnosticSuspect[] {
  const candidates: DiagnosticArtifactV1["streams"]["requests"] = [];
  for (const record of records) {
    if (typeof record.durationMs === "number" && record.durationMs >= 100) {
      candidates.push(record);
    }
  }

  const suspects: DiagnosticSuspect[] = [];
  const sorted = candidates.toSorted(
    (left, right) => (right.durationMs ?? 0) - (left.durationMs ?? 0),
  );
  for (const record of sorted.slice(0, limit)) {
    suspects.push({
      detail: {
        durationMs: record.durationMs,
        method: record.method,
        path: record.path,
        suspectCategory: "resource-request",
        status: record.status,
      },
      id: `request-slow:${record.method}:${record.path}`,
      lane: "api",
      reason: `slow request: ${record.method} ${record.path} (${record.durationMs} ms)`,
      severity: (record.durationMs ?? 0) >= 1_000 ? "critical" : "warning",
    });
  }
  return suspects;
}

function repeatedRequests(
  records: DiagnosticArtifactV1["streams"]["requests"],
): DiagnosticSuspect[] {
  const counts = new Map<string, number>();
  for (const record of records) {
    const key = record.resourceKey ?? `${record.method} ${record.path}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const repeated: Array<[string, number]> = [];
  for (const entry of counts.entries()) {
    if (entry[1] >= 3) repeated.push(entry);
  }

  const suspects: DiagnosticSuspect[] = [];
  for (const [resourceKey, count] of repeated.toSorted((left, right) => right[1] - left[1])) {
    suspects.push({
      detail: { count, resourceKey },
      id: `request-repeat:${resourceKey}`,
      lane: "api",
      reason: `repeated request/resource key: ${resourceKey} (${count} samples)`,
      severity: count >= 10 ? "critical" : "warning",
    });
  }
  return suspects;
}

function viewport3DBuildPhaseSuspects(
  records: DiagnosticArtifactV1["streams"]["viewport3dBuild"],
): DiagnosticSuspect[] {
  const suspects: DiagnosticSuspect[] = [];
  for (const record of records) {
    const phase = dominantViewport3DBuildPhase(record);
    if (!phase || phase.valueMs < 100) continue;
    suspects.push({
      detail: {
        buildKey: record.buildKey,
        buildLane: record.buildLane,
        durationMs: record.durationMs,
        phaseMs: phase.valueMs,
        suspectCategory: phase.category,
      },
      id: `viewport3d-build:${phase.category}:${record.id || record.buildKey}`,
      lane: "viewport-3d",
      reason: `viewport 3D ${phase.label}: ${record.buildLane} ${phase.valueMs} ms`,
      severity: phase.valueMs >= 1_000 ? "critical" : "warning",
    });
  }
  return suspects;
}

function visibleRevisionSuspects(
  summary: DiagnosticArtifactV1["viewport3dVisibleRevisionSummary"],
): DiagnosticSuspect[] {
  return [
    ...summary.stalePhysicalTargets.map((target, index) => ({
      detail: {
        displayedRevision: target.displayedRevision,
        lane: target.lane,
        suspectCategory: "visible-stale",
        targetKey: target.targetKey,
        targetRevision: target.targetRevision,
      },
      id: `viewport3d-visible:stale-physical:${index}:${target.targetKey ?? "unknown"}`,
      lane: "viewport-3d" as const,
      reason: `visible stale physical viewport 3D target: ${target.targetKey ?? target.lane ?? "unknown"} displays ${target.displayedRevision ?? "unknown"} while target is ${target.targetRevision ?? "unknown"}`,
      severity: "warning" as const,
    })),
    ...summary.staleCompatibleTargets.map((target, index) => ({
      detail: {
        displayedRevision: target.displayedRevision,
        lane: target.lane,
        suspectCategory: "visible-stale",
        targetKey: target.targetKey,
        targetRevision: target.targetRevision,
      },
      id: `viewport3d-visible:stale-compatible:${index}:${target.targetKey ?? "unknown"}`,
      lane: "viewport-3d" as const,
      reason: `visible stale compatible viewport 3D target: ${target.targetKey ?? target.lane ?? "unknown"}`,
      severity: "info" as const,
    })),
    ...summary.invalidSuppressedTargets.map((target, index) => ({
      detail: {
        displayedRevision: target.displayedRevision,
        lane: target.lane,
        suspectCategory: "visible-stale",
        targetKey: target.targetKey,
        targetRevision: target.targetRevision,
      },
      id: `viewport3d-visible:invalid:${index}:${target.targetKey ?? "unknown"}`,
      lane: "viewport-3d" as const,
      reason: `invalid stale viewport 3D target suppressed: ${target.targetKey ?? target.lane ?? "unknown"}`,
      severity: "warning" as const,
    })),
  ];
}

function memorySuspects(
  records: DiagnosticArtifactV1["streams"]["memory"],
): DiagnosticSuspect[] {
  const suspects: DiagnosticSuspect[] = [];
  for (const record of records) {
    if (
      record.name !== DIAGNOSTIC_EVENT_NAMES.leakCheck ||
      (record.severity !== "critical" && record.severity !== "warning")
    ) {
      continue;
    }
    suspects.push({
      detail: record.detail,
      id: `memory:${record.id || record.timestampMs}`,
      lane: "memory",
      reason: `memory leak check reported ${String(record.detail.classification ?? record.severity)}`,
      severity: record.severity,
    });
  }
  return suspects;
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
  const suspects: DiagnosticSuspect[] = [];
  for (const record of records) {
    if (record.level !== "error") continue;
    suspects.push({
      detail: {
        message: record.message.slice(0, 240),
        source: record.source,
      },
      id: `console:${record.id || record.timestampMs}`,
      lane: "console",
      reason: `console/page error: ${record.message.slice(0, 160)}`,
      severity: "critical",
    });
  }
  return suspects;
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
  lines.push("", "## Suspect Sections");
  const sections = classifiedSuspectSections(suspects);
  if (sections.length === 0) {
    lines.push("No classified suspect sections detected.");
  } else {
    for (const section of sections) {
      lines.push("", `### ${section.label}`);
      for (const suspect of section.suspects.slice(0, 5)) {
        lines.push(`- [${suspect.severity}] ${suspect.reason}`);
      }
    }
  }
  return lines.join("\n");
}

function dominantViewport3DBuildPhase(record: DiagnosticArtifactV1["streams"]["viewport3dBuild"][number]):
  | {
      category: string;
      label: string;
      valueMs: number;
    }
  | null {
  const phases = [
    {
      category: "worker-queue",
      label: "queue bottleneck",
      valueMs: record.queueWaitMs || numberValue(record, "queueWaitMs"),
    },
    {
      category: "worker-compute",
      label: "worker bottleneck",
      valueMs:
        record.workerComputeMs || numberValue(record, "workerComputeMs"),
    },
    {
      category: "worker-transfer",
      label: "transfer bottleneck",
      valueMs: record.transferMs || numberValue(record, "transferMs"),
    },
    {
      category: "main-adoption",
      label: "main-thread adoption bottleneck",
      valueMs: record.mainAdoptMs || numberValue(record, "mainAdoptMs"),
    },
    {
      category: "gpu-upload",
      label: "GPU upload bottleneck",
      valueMs: record.mainUploadMs || numberValue(record, "mainUploadMs"),
    },
  ];
  return phases.toSorted((left, right) => right.valueMs - left.valueMs)[0] ?? null;
}

function classifyRecordSuspectCategory(record: DiagnosticRecord): string {
  if (record.lane === "react") return "react-render";
  if (record.lane === "api") return "resource-request";
  if (record.lane === "resource-cache") return "resource-request";
  if (record.lane === "webgl") return "browser-gpu-driver";
  const bucket = stringValue(record, "bucket");
  if (bucket === "binary-decode") return "binary-decode";
  if (bucket === "viewport-upload") return "gpu-upload";
  if (bucket === "resource-cache") return "resource-request";
  if (record.name.includes("frame")) return "r3f-frame-loop";
  return "unknown-insufficient-instrumentation";
}

function classifiedSuspectSections(
  suspects: readonly DiagnosticSuspect[],
): Array<{
  label: string;
  suspects: DiagnosticSuspect[];
}> {
  const labels = [
    ["worker-queue", "Queue Bottleneck"],
    ["worker-compute", "Worker Bottleneck"],
    ["worker-transfer", "Transfer Bottleneck"],
    ["main-adoption", "Main Adoption Bottleneck"],
    ["gpu-upload", "GPU Upload Bottleneck"],
    ["react-render", "React Rerender Bottleneck"],
    ["resource-request", "Resource/Decode Bottleneck"],
    ["binary-decode", "Resource/Decode Bottleneck"],
    ["r3f-frame-loop", "R3F Frame Loop Bottleneck"],
    ["browser-gpu-driver", "Browser/GPU Driver Suspicion"],
    ["visible-stale", "Visible Stale Revision"],
    ["unknown-insufficient-instrumentation", "Unknown/Insufficient Instrumentation"],
  ] as const;
  const sections: Array<{
    label: string;
    suspects: DiagnosticSuspect[];
  }> = [];
  for (const [category, label] of labels) {
    const sectionSuspects: DiagnosticSuspect[] = [];
    for (const suspect of suspects) {
      if (suspect.detail.suspectCategory === category) {
        sectionSuspects.push(suspect);
      }
    }
    if (sectionSuspects.length > 0) {
      sections.push({ label, suspects: sectionSuspects });
    }
  }
  return sections;
}

function allRecords(
  streams: DiagnosticArtifactV1["streams"],
): DiagnosticAnyRecord[] {
  return Object.values(streams).flat() as DiagnosticAnyRecord[];
}
