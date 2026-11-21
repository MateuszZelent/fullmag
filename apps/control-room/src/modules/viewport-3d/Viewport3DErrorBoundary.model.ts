import type { DiagnosticConsoleRecord } from "@/kernel/performance/diagnostic-recorder/diagnosticRecorderTypes";

const FORENSIC_TEXT_LIMIT = 8_000;

export function createViewport3DRenderErrorRecord(
  error: unknown,
  componentStack: string | null | undefined,
  timestampMs = Date.now(),
): DiagnosticConsoleRecord {
  const normalized = error instanceof Error ? error : new Error(String(error));
  return {
    byteLength: null,
    detail: {
      componentStack: boundForensicText(componentStack ?? ""),
      errorStack: boundForensicText(normalized.stack ?? ""),
    },
    droppedCount: 0,
    durationMs: null,
    id: `viewport-3d-render-error-${timestampMs}`,
    kind: "console",
    lane: "react",
    level: "error",
    message: normalized.message,
    name: "viewport-3d.render-error",
    severity: "critical",
    source: "Viewport3DErrorBoundary",
    startTimeMs: null,
    timestampMs,
  };
}

function boundForensicText(value: string): string {
  return value.length <= FORENSIC_TEXT_LIMIT
    ? value
    : value.slice(0, FORENSIC_TEXT_LIMIT);
}
