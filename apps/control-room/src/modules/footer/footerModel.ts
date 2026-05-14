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
  return new Date(timestampMs).toISOString().slice(11, 19);
}

export function summarizeTransportPath(entry: RequestDiagnosticEntry): string {
  if (entry.channel === "websocket") {
    return entry.messageType ?? entry.path;
  }

  return entry.path;
}
