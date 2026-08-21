import { MAX_VISUALIZATION_DEBUG_SNAPSHOT_BYTES } from "@/kernel/visualization/VisualizationDebugController";
import { copyTextToClipboard } from "@/shared/browser/copyTextToClipboard";

import type { VisualizationDebugPanelModel } from "./VisualizationDebugPanelModel";
import {
  allIssues,
  allObservations,
  formatBackendStats,
  formatBytes,
  formatContext,
  formatDrawingBuffer,
  formatDuration,
  formatTimestamp,
  memoryGroups,
  statisticsRows,
} from "./visualizationDebugPresentation";

export const VISUALIZATION_DEBUG_EXPORT_SCHEMA_VERSION =
  "fullmag.visualization-debug.v2" as const;
export const VISUALIZATION_DEBUG_EXPORT_MIME = "application/json";
export const MAX_VISUALIZATION_DEBUG_EXPORT_BYTES =
  MAX_VISUALIZATION_DEBUG_SNAPSHOT_BYTES;

const FEEDBACK_DURATION_MS = 1_800;
const encoder = new TextEncoder();

export interface VisualizationDebugExportIssue {
  code: string;
  message: string;
}

export interface VisualizationDebugExportDocument {
  exportedAtMs: number;
  issues: readonly VisualizationDebugExportIssue[];
  model: Readonly<Record<string, unknown>> & {
    disposition: VisualizationDebugPanelModel["disposition"];
    issues: VisualizationDebugPanelModel["issues"];
    state: VisualizationDebugPanelModel["state"];
  };
  schemaVersion: typeof VISUALIZATION_DEBUG_EXPORT_SCHEMA_VERSION;
}

export interface VisualizationDebugExportResult {
  document: VisualizationDebugExportDocument;
  json: string;
  mime: typeof VISUALIZATION_DEBUG_EXPORT_MIME;
}

export type VisualizationDebugActionFeedback = {
  kind: "error" | "success";
  message: string;
} | null;

export interface VisualizationDebugTimerSeam {
  clear(handle: unknown): void;
  set(callback: () => void, delayMs: number): unknown;
}

export interface VisualizationDebugEvidenceActionDependencies {
  clipboard: Pick<Clipboard, "writeText">;
  createObjectURL(blob: Blob): string;
  download(url: string, filename: string): void;
  feedback(value: VisualizationDebugActionFeedback): void;
  now(): number;
  revokeObjectURL(url: string): void;
  timers: VisualizationDebugTimerSeam;
}

export interface VisualizationDebugEvidenceActions {
  copyLog(): Promise<void>;
  copyResourceKey(): Promise<void>;
  copySnapshot(): Promise<void>;
  dispose(): void;
  exportJson(): void;
  rawJson(): string;
}

export type VisualizationDebugEvidenceActionsFactory = (
  model: VisualizationDebugPanelModel,
  dependencies: VisualizationDebugEvidenceActionDependencies,
) => VisualizationDebugEvidenceActions;

export type VisualizationDebugEvidenceActionEnvironment = Omit<
  VisualizationDebugEvidenceActionDependencies,
  "feedback"
>;

export function buildVisualizationDebugExport(
  model: VisualizationDebugPanelModel,
  exportedAtMs: number,
): VisualizationDebugExportResult {
  try {
    const document: VisualizationDebugExportDocument = {
      exportedAtMs: safeExportedAtMs(exportedAtMs),
      issues: [],
      model: jsonClone(model) as VisualizationDebugExportDocument["model"],
      schemaVersion: VISUALIZATION_DEBUG_EXPORT_SCHEMA_VERSION,
    };
    const json = JSON.stringify(document, null, 2);
    if (utf8ByteLength(json) <= MAX_VISUALIZATION_DEBUG_EXPORT_BYTES) {
      return { document, json, mime: VISUALIZATION_DEBUG_EXPORT_MIME };
    }
    return buildSafeBoundedVisualizationDebugExport(model, exportedAtMs, "size");
  } catch {
    return buildSafeBoundedVisualizationDebugExport(
      model,
      exportedAtMs,
      "serialization",
    );
  }
}

export function buildVisualizationDebugLog(
  model: VisualizationDebugPanelModel,
  exportedAtMs: number,
): string {
  const lines: string[] = ["Fullmag Visualization Debug Log"];
  const add = (label: string, value: unknown) => {
    lines.push(`${label}\t${formatLogValue(value)}`);
  };
  const section = (title: string) => {
    lines.push("", title);
  };
  const observations = allObservations(model);

  add("Exported at", formatLogTimestamp(exportedAtMs));
  add("State", model.state);
  add("Health", model.disposition);
  add("Target", model.target?.id ?? "—");
  add("Target kind", model.target?.kind ?? "—");
  add("Selection kind", model.target?.selectionKind ?? "—");

  section("Authoritative lifecycle & mutation receipt");
  const lifecycle = model.mutationEvidence.lifecycle;
  add("Lifecycle source", lifecycle.source);
  add("Session resource status", lifecycle.session.resourceStatus);
  add("Session resource revision", lifecycle.session.resourceRevision ?? "—");
  add("Session ID", lifecycle.session.session?.session_id ?? "—");
  add("Session epoch", lifecycle.session.session?.session_epoch ?? "—");
  add("Session resource lifecycle", lifecycle.session.lifecycle?.session_resource ?? "—");
  add("Session solver lifecycle", lifecycle.session.lifecycle?.solver ?? "—");
  add("Session commandability", lifecycle.session.lifecycle?.commandability ?? "—");
  add("Session connectivity", lifecycle.session.lifecycle?.connectivity ?? "—");
  add("Solver resource status", lifecycle.solver.resourceStatus);
  add("Solver resource revision", lifecycle.solver.resourceRevision ?? "—");
  add("Solver runtime state", lifecycle.solver.status?.runtime_state ?? "—");
  add("Solver runtime status", lifecycle.solver.status?.runtime_status_kind ?? "—");
  add("Solver runtime code", lifecycle.solver.status?.runtime_status_code ?? "—");
  add("Solver session status", lifecycle.solver.status?.session_status ?? "—");
  add("Solver run / stage", [lifecycle.solver.status?.run_id ?? "—", lifecycle.solver.status?.stage_kind ?? "—"]);
  add(
    "Realtime connectivity",
    `${model.mutationEvidence.connectivity.status} · disrupted=${model.mutationEvidence.connectivity.disrupted}`,
  );
  add("Authoritative visualization revision", model.mutationEvidence.sync.lastRemoteRevision ?? "—");
  const mutation = model.mutationEvidence.sync.mutation;
  add("PATCH status", mutation?.status ?? "idle");
  add("PATCH transaction IDs", mutation?.transactionIds ?? []);
  add("PATCH response revision", mutation?.responseRevision ?? "—");
  add("PATCH response request ID", mutation?.requestId ?? "—");
  add("PATCH target", mutation?.targetId ?? "—");
  add("PATCH error", mutation?.error ?? "—");
  add("Pending target IDs", model.mutationEvidence.sync.pendingTargetIds);
  add("Rejected target IDs", model.mutationEvidence.sync.rejectedTargetIds);

  section("Viewport & carriers");
  for (const viewport of model.viewports) {
    lines.push(`Viewport\t${viewport.viewportId}`);
    const snapshot = viewport.snapshots.at(-1) ?? null;
    add("Committed frame", snapshot?.viewport.frameCommitId ?? "—");
    add("Context", formatContext(snapshot));
    add("Drawing buffer", formatDrawingBuffer(snapshot));
    add("Client acknowledgements", `${viewport.clientAcks.length} (viewport-wide)`);
    for (const carrier of viewport.carriers) {
      lines.push(`Carrier\t${carrier.carrierId}`);
      const observation = carrier.observations.at(-1);
      add("Carrier role", observation?.carrier.carrierRole ?? "—");
      add(
        "Field resource",
        formatFieldResourceLogValue(observation?.carrier.fieldResourceState ?? null),
      );
      add("Observations", carrier.observations.length);
    }
  }

  section("Request & transport");
  for (const observation of observations) {
    lines.push(`Carrier\t${observation.carrier.carrierId}`);
    add("Planner request ID", observation.carrier.request.plannerRequestId ?? "—");
    add("Canonical resource key", observation.carrier.request.resourceKey ?? "—");
    add("Requested component", observation.query?.component ?? "—");
    add("Geometry scope", observation.query?.geometryScope ?? "full");
    add("Maximum samples", observation.query?.maxSamples ?? "all");
    add("Scope", observation.query
      ? `${observation.query.scopeKind}:${observation.query.scopeId ?? "—"}`
      : "—");
  }
  for (const entry of model.transport) {
    add(
      "Transport",
      [
        entry.requestId,
        entry.path,
        entry.status ?? entry.outcome,
        formatDuration(entry.durationMs),
        formatBytes(entry.byteLength),
        entry.etag ?? "—",
        formatTimestamp(entry.timestampMs),
      ].join("\t"),
    );
    add("Transport detail", entry.detail ?? "—");
  }

  section("Backend metadata");
  for (const observation of observations) {
    lines.push(`Carrier\t${observation.carrier.carrierId}`);
    if (!observation.backendMeta) {
      add("Metadata", "not available for this exact query");
      continue;
    }
    add(
      "Quantity",
      `${observation.backendMeta.quantity_id} — ${observation.backendMeta.label}`,
    );
    add(
      "Kind / location",
      `${observation.backendMeta.kind} / ${observation.backendMeta.location}`,
    );
    add("Components", observation.backendMeta.components);
    add("Field revision", observation.backendMeta.field_revision);
    add("Domain generation", observation.backendMeta.domain_generation_id);
    add(
      "Backend min / max / mean",
      `${formatBackendStats(observation.backendMeta.stats)} ${observation.backendMeta.unit}`,
    );
  }

  section("Decoded payload");
  for (const observation of observations) {
    lines.push(`Carrier\t${observation.carrier.carrierId}`);
    const payload = observation.carrier.payload;
    if (!payload) {
      add("Payload", "not available");
      continue;
    }
    add("Dtype / FMVP", `${payload.dtype} / v${payload.formatVersion ?? "—"}`);
    add("Grid", payload.grid.join(" × "));
    add("nComp", payload.nComp);
    add("Decoded component", payload.component ?? "— (not encoded)");
    add("Points / values", `${payload.pointCount} / ${payload.valueCount}`);
    add(
      "Indexing / node indices",
      `${payload.indexing} / ${payload.nodeIndexCount ?? "—"}`,
    );
    add("Scope", `${payload.scopeKind ?? "—"}:${payload.scopeId ?? "—"}`);
  }

  section("Statistics");
  for (const row of statisticsRows(observations)) {
    add(
      `${row.carrierId} · ${row.source}`,
      [row.min, row.max, row.mean, row.p01, row.p99, row.unit, row.counts]
        .map(formatLogValue)
        .join("\t"),
    );
  }

  section("Sample values");
  for (const observation of observations) {
    for (const sample of observation.carrier.samples.slice(0, 12)) {
      add(
        `${observation.carrier.carrierId} sample ${sample.pointIndex}`,
        [
          `node=${sample.nodeIndex ?? "—"}`,
          `components=${JSON.stringify(sample.componentValues)}`,
          `magnitude=${formatLogValue(sample.magnitude)}`,
        ].join(" "),
      );
    }
  }

  section("Memory");
  for (const group of memoryGroups(model)) {
    lines.push(group.ownership);
    for (const row of group.rows) {
      add(`${row.label} · ${row.source}`, formatBytes(row.byteLength));
    }
    add("Group total", formatBytes(group.total));
  }

  section("Render passes");
  for (const observation of observations) {
    const carrier = observation.carrier;
    lines.push(`Carrier\t${carrier.carrierId}`);
    add("Requested source", carrier.request.resourceKey ?? "—");
    add("Surface source", carrier.render.adoption.surface.adoptedResourceKey ?? "—");
    add(
      "Surface field buffer",
      `${carrier.render.fieldBufferState} · ${carrier.render.adoption.surface.adoptedFieldBufferId ?? "not adopted"}`,
    );
    add("Vector source", carrier.render.adoption.vector.adoptedResourceKey ?? "—");
    add(
      "Vector field buffer",
      `${carrier.render.fieldBufferState} · ${carrier.render.adoption.vector.adoptedFieldBufferId ?? "not adopted"}`,
    );
    add(
      "Vectors",
      `${carrier.render.vectors.buildKey ?? "not built"} · ${carrier.render.vectors.segmentCount ?? 0} segments · ${carrier.render.vectors.degradation ?? "not degraded"}`,
    );
  }

  section("Revisions & provenance");
  for (const observation of observations) {
    const carrier = observation.carrier;
    lines.push(`Carrier\t${carrier.carrierId}`);
    add(
      "Visualization / field",
      `${carrier.revisions.visualizationRevision ?? "—"} / ${carrier.revisions.fieldRevision ?? "—"}`,
    );
    add(
      "Topology / domain",
      `${carrier.revisions.topologyRevision ?? "—"} / ${carrier.revisions.domainGenerationId ?? "—"}`,
    );
    add("Topology hash", carrier.revisions.meshTopologyHash ?? "—");
    add("Cache ETag", carrier.cache.etag ?? "—");
    add(
      "Rendered acknowledgement",
      carrier.render.adoption.frameCommitId ?? observation.snapshot.viewport.frameCommitId,
    );
    add(
      "Adoption receipt/state",
      `${carrier.render.adoption.surface.adoptedFieldBufferId ?? "none"} / ${carrier.render.adoption.vector.adoptedFieldBufferId ?? "none"} · ${carrier.render.fieldBufferState}`,
    );
  }

  section("Detected inconsistencies");
  const issues = allIssues(model);
  if (issues.length === 0) {
    add("Issues", "none");
  } else {
    for (const issue of issues) {
      add(
        `${issue.severity}: ${issue.code}`,
        `${issue.source} — ${issue.message}`,
      );
      if (issue.evidence.length > 0) add("Evidence", issue.evidence.join(" · "));
    }
  }

  return boundVisualizationDebugLog(lines.join("\n"));
}

function formatFieldResourceLogValue(
  state: VisualizationDebugPanelModel["viewports"][number]["carriers"][number]["observations"][number]["carrier"]["fieldResourceState"] | null,
): string {
  if (!state) return "not tracked";
  const reason = state.reasonCode ? ` · ${state.reasonCode}` : "";
  const revision = state.revision ? ` · rev ${state.revision}` : "";
  return `${state.status} · data ${state.dataAvailable ? "present" : "absent"} · last-valid ${state.lastValidDataAvailable ? "present" : "absent"}${reason}${revision}`;
}

function formatLogTimestamp(value: number): string {
  return typeof value === "number" && Number.isFinite(value)
    ? new Date(value).toISOString()
    : "unknown";
}

function formatLogValue(value: unknown): string {
  if (value == null) return "—";
  if (typeof value === "string") return value.replace(/[\r\n]+/g, " ");
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "—";
  if (typeof value === "boolean") return value ? "true" : "false";
  try {
    return JSON.stringify(value) ?? "—";
  } catch {
    return "[unserializable]";
  }
}

function boundVisualizationDebugLog(value: string): string {
  if (utf8ByteLength(value) <= MAX_VISUALIZATION_DEBUG_EXPORT_BYTES) return value;
  const marker = "\n[log truncated at the 64 KiB evidence limit]";
  let bounded = "";
  for (const line of value.split("\n")) {
    const candidate = bounded ? `${bounded}\n${line}` : line;
    if (utf8ByteLength(`${candidate}${marker}`) > MAX_VISUALIZATION_DEBUG_EXPORT_BYTES) {
      break;
    }
    bounded = candidate;
  }
  return `${bounded}${marker}`;
}

function buildSafeBoundedVisualizationDebugExport(
  model: VisualizationDebugPanelModel,
  exportedAtMs: number,
  reason: "serialization" | "size",
): VisualizationDebugExportResult {
  try {
    const result = buildBoundedVisualizationDebugExport(
      model,
      exportedAtMs,
      reason,
    );
    if (utf8ByteLength(result.json) <= MAX_VISUALIZATION_DEBUG_EXPORT_BYTES) {
      return result;
    }
  } catch {
    // The minimal document below does not access backend-derived model values.
  }

  const document: VisualizationDebugExportDocument = {
    exportedAtMs: safeExportedAtMs(exportedAtMs),
    issues: [boundedExportIssue(reason)],
    model: {
      disposition: "unknown",
      issues: [],
      state: "missing-snapshot",
    },
    schemaVersion: VISUALIZATION_DEBUG_EXPORT_SCHEMA_VERSION,
  };
  return {
    document,
    json: JSON.stringify(document, null, 2),
    mime: VISUALIZATION_DEBUG_EXPORT_MIME,
  };
}

function buildBoundedVisualizationDebugExport(
  model: VisualizationDebugPanelModel,
  exportedAtMs: number,
  reason: "serialization" | "size",
): VisualizationDebugExportResult {
  const document: VisualizationDebugExportDocument = {
    exportedAtMs: safeExportedAtMs(exportedAtMs),
    issues: [boundedExportIssue(reason)],
    model: {
      carrierCount: model.viewports.reduce(
        (count, viewport) => count + viewport.carriers.length,
        0,
      ),
      disposition: model.disposition,
      issueCount: model.issues.length,
      issues: [],
      snapshotCount: model.viewports.reduce(
        (count, viewport) => count + viewport.snapshots.length,
        0,
      ),
      state: model.state,
      target: model.target ? { kind: model.target.kind } : null,
      transportEntryCount: model.transport.length,
      viewportCount: model.viewports.length,
    },
    schemaVersion: VISUALIZATION_DEBUG_EXPORT_SCHEMA_VERSION,
  };
  const json = JSON.stringify(document, null, 2);
  return {
    document,
    json,
    mime: VISUALIZATION_DEBUG_EXPORT_MIME,
  };
}

function boundedExportIssue(
  reason: "serialization" | "size",
): VisualizationDebugExportIssue {
  return reason === "size"
    ? {
        code: "export-size-limit",
        message:
          "Full evidence exceeded the 64 KiB UTF-8 export budget; a bounded summary replaces the oversized payload.",
      }
    : {
        code: "export-serialization-failed",
        message:
          "Full evidence could not be serialized; a bounded summary replaces the invalid payload.",
      };
}

function safeExportedAtMs(value: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function createVisualizationDebugEvidenceActions(
  model: VisualizationDebugPanelModel,
  dependencies: VisualizationDebugEvidenceActionDependencies =
    browserEvidenceActionDependencies(),
): VisualizationDebugEvidenceActions {
  let disposed = false;
  let feedbackTimer: unknown = null;

  const clearFeedbackTimer = () => {
    if (feedbackTimer === null) return;
    dependencies.timers.clear(feedbackTimer);
    feedbackTimer = null;
  };
  const publishFeedback = (feedback: Exclude<VisualizationDebugActionFeedback, null>) => {
    if (disposed) return;
    clearFeedbackTimer();
    dependencies.feedback(feedback);
    feedbackTimer = dependencies.timers.set(() => {
      feedbackTimer = null;
      if (!disposed) dependencies.feedback(null);
    }, FEEDBACK_DURATION_MS);
  };
  const build = () => buildVisualizationDebugExport(model, dependencies.now());
  const buildLog = () => buildVisualizationDebugLog(model, dependencies.now());

  return {
    async copyLog() {
      try {
        await dependencies.clipboard.writeText(buildLog());
        publishFeedback({ kind: "success", message: "Debug log copied." });
      } catch {
        publishFeedback({
          kind: "error",
          message: "Debug log could not be copied.",
        });
      }
    },
    async copyResourceKey() {
      const resourceKey = firstExactResourceKey(model);
      if (!resourceKey) {
        publishFeedback({
          kind: "error",
          message: "No exact resource key is available to copy.",
        });
        return;
      }
      try {
        await dependencies.clipboard.writeText(resourceKey);
        publishFeedback({ kind: "success", message: "Resource key copied." });
      } catch {
        publishFeedback({
          kind: "error",
          message: "Resource key could not be copied.",
        });
      }
    },
    async copySnapshot() {
      try {
        await dependencies.clipboard.writeText(build().json);
        publishFeedback({ kind: "success", message: "Snapshot copied." });
      } catch {
        publishFeedback({
          kind: "error",
          message: "Snapshot could not be copied.",
        });
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearFeedbackTimer();
      dependencies.feedback(null);
    },
    exportJson() {
      let objectUrl: string | null = null;
      try {
        const result = build();
        const blob = new Blob([result.json], { type: result.mime });
        objectUrl = dependencies.createObjectURL(blob);
        dependencies.download(
          objectUrl,
          `fullmag-visualization-debug-${safeFilenamePart(model.target?.id ?? "unknown")}-${Math.trunc(dependencies.now())}.json`,
        );
        publishFeedback({ kind: "success", message: "JSON evidence exported." });
      } catch {
        publishFeedback({
          kind: "error",
          message: "JSON evidence could not be exported.",
        });
      } finally {
        if (objectUrl !== null) dependencies.revokeObjectURL(objectUrl);
      }
    },
    rawJson() {
      return build().json;
    },
  };
}

export function createBrowserVisualizationDebugEvidenceEnvironment(
  now: () => number = () => Date.now(),
): VisualizationDebugEvidenceActionEnvironment {
  return {
    clipboard: {
      writeText: (text) => copyTextToClipboard(text),
    },
    createObjectURL: (blob) => URL.createObjectURL(blob),
    download: (url, filename) => {
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
    },
    now,
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
    timers: {
      clear: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
      set: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    },
  };
}

function browserEvidenceActionDependencies(): VisualizationDebugEvidenceActionDependencies {
  return {
    ...createBrowserVisualizationDebugEvidenceEnvironment(),
    feedback: () => undefined,
  };
}

function firstExactResourceKey(model: VisualizationDebugPanelModel): string | null {
  for (const viewport of model.viewports) {
    for (const carrier of viewport.carriers) {
      for (const observation of carrier.observations) {
        const requested = observation.carrier.request.resourceKey;
        if (requested) return requested;
        const adoptedSurface = observation.carrier.render.adoption.surface.adoptedResourceKey;
        if (adoptedSurface) return adoptedSurface;
        const adoptedVector = observation.carrier.render.adoption.vector.adoptedResourceKey;
        if (adoptedVector) return adoptedVector;
      }
    }
  }
  return null;
}

function jsonClone(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function safeFilenamePart(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function utf8ByteLength(value: string): number {
  return encoder.encode(value).byteLength;
}
