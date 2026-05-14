import type {
  RequestDiagnosticEntry,
  TransportChannel,
  TransportDirection,
} from "@/kernel/api/RequestDiagnosticsController";

export type FooterDirectionFilter = "all" | TransportDirection;
export type FooterChannelFilter = "all" | TransportChannel;

export interface FooterLogFilters {
  channel: FooterChannelFilter;
  direction: FooterDirectionFilter;
}

export function filterTransportEntries(
  entries: readonly RequestDiagnosticEntry[],
  filters: FooterLogFilters,
): RequestDiagnosticEntry[] {
  return entries.filter((entry) => {
    if (filters.direction !== "all" && entry.direction !== filters.direction) {
      return false;
    }

    if (filters.channel !== "all" && entry.channel !== filters.channel) {
      return false;
    }

    return true;
  });
}

export function formatTransportByteSize(byteLength: number | null): string {
  if (byteLength === null) {
    return "—";
  }

  if (byteLength < 1024) {
    return `${byteLength} B`;
  }

  const units = ["KB", "MB", "GB"];
  let value = byteLength / 1024;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[unitIndex]}`;
}

export function formatTransportTimestamp(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(11, 23);
}

export function formatTransportTimestampSignature(timestampMs: number): string {
  return new Date(timestampMs).toISOString();
}

export function formatTransportDuration(durationMs: number | null): string {
  if (durationMs === null) {
    return "—";
  }

  return `${Math.round(durationMs)} ms`;
}

export function buildTransportMessagePreview(
  entry: RequestDiagnosticEntry,
): string {
  const direction = entry.direction.toUpperCase();

  if (entry.channel === "websocket") {
    const messageType = entry.messageType ?? "message";
    return `${direction} WS ${messageType}`;
  }

  return `${direction} ${entry.method} ${entry.path}`;
}

export function summarizeTransportPath(entry: RequestDiagnosticEntry): string {
  if (entry.channel === "websocket") {
    return entry.messageType ?? entry.path;
  }

  return entry.path;
}

export function serializeTransportEntry(entry: RequestDiagnosticEntry): string {
  return JSON.stringify(
    {
      byteLength: entry.byteLength,
      channel: entry.channel,
      contentType: entry.contentType,
      detail: entry.detail,
      direction: entry.direction,
      durationMs: entry.durationMs,
      id: entry.id,
      messageType: entry.messageType,
      method: entry.method,
      outcome: entry.outcome,
      path: entry.path,
      requestId: entry.requestId,
      status: entry.status,
      timestamp: formatTransportTimestampSignature(entry.timestampMs),
      timestampMs: entry.timestampMs,
    },
    null,
    2,
  );
}
