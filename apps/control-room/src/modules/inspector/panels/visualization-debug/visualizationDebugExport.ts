import { MAX_VISUALIZATION_DEBUG_SNAPSHOT_BYTES } from "@/kernel/visualization/VisualizationDebugController";

import type { VisualizationDebugPanelModel } from "./VisualizationDebugPanelModel";

export const VISUALIZATION_DEBUG_EXPORT_SCHEMA_VERSION =
  "fullmag.visualization-debug.v1" as const;
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

  return {
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
      writeText: (text) => {
        if (typeof navigator === "undefined" || !navigator.clipboard) {
          return Promise.reject(new Error("Clipboard API is unavailable."));
        }
        return navigator.clipboard.writeText(text);
      },
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
        const adopted = observation.carrier.render.adoption.adoptedResourceKey;
        if (adopted) return adopted;
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
