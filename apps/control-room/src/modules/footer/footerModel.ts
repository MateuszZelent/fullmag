import type {
  RequestDiagnosticEntry,
  TransportChannel,
  TransportDirection,
} from "@/kernel/api/RequestDiagnosticsController";

export type FooterDirectionFilter = "all" | TransportDirection;
export type FooterChannelFilter = "all" | "transport" | TransportChannel;
type FooterLogSortDirection = "asc" | "desc";
export type FooterLogSortKey =
  | "channel"
  | "direction"
  | "latency"
  | "size"
  | "status"
  | "time";

export interface FooterLogFilters {
  channel: FooterChannelFilter;
  direction: FooterDirectionFilter;
}

export interface FooterLogSort {
  direction: FooterLogSortDirection;
  key: FooterLogSortKey;
}

export function filterTransportEntries(
  entries: readonly RequestDiagnosticEntry[],
  filters: FooterLogFilters,
): RequestDiagnosticEntry[] {
  return entries.filter((entry) => {
    if (!isFooterLogEntry(entry)) {
      return false;
    }

    if (filters.direction !== "all" && entry.direction !== filters.direction) {
      return false;
    }

    if (filters.channel === "transport") {
      return entry.channel === "http" || entry.channel === "websocket";
    }

    if (filters.channel !== "all" && entry.channel !== filters.channel) {
      return false;
    }

    return true;
  });
}

export function isFooterLogEntry(entry: RequestDiagnosticEntry): boolean {
  return !(
    entry.channel === "performance" &&
    entry.path.startsWith("fullmag.react.render.")
  );
}

export function sortTransportEntries(
  entries: readonly RequestDiagnosticEntry[],
  sort: FooterLogSort,
): RequestDiagnosticEntry[] {
  return entries.toSorted((left, right) => {
    const order =
      compareTransportEntries(left, right, sort.key) ||
      compareString(left.id, right.id);
    return sort.direction === "asc" ? order : -order;
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

function compareTransportEntries(
  left: RequestDiagnosticEntry,
  right: RequestDiagnosticEntry,
  key: FooterLogSortKey,
): number {
  switch (key) {
    case "channel":
      return compareString(left.channel, right.channel);
    case "direction":
      return compareString(left.direction, right.direction);
    case "latency":
      return compareNullableNumber(left.durationMs, right.durationMs);
    case "size":
      return compareNullableNumber(left.byteLength, right.byteLength);
    case "status":
      return (
        compareNullableNumber(left.status, right.status) ||
        compareString(left.outcome, right.outcome)
      );
    case "time":
      return left.timestampMs - right.timestampMs;
  }
}

function compareNullableNumber(
  left: number | null,
  right: number | null,
): number {
  if (left === null && right === null) {
    return 0;
  }

  if (left === null) {
    return 1;
  }

  if (right === null) {
    return -1;
  }

  return left - right;
}

function compareString(left: string, right: string): number {
  return left.localeCompare(right);
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

  if (entry.channel === "performance") {
    return `${direction} PERF ${entry.path}`;
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
  const correlation = resolveTransportCorrelation(entry);
  return JSON.stringify(
    {
      byteLength: entry.byteLength,
      channel: entry.channel,
      commandId: correlation.commandId,
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
      resourceKey: correlation.resourceKey,
      stageId: correlation.stageId,
      status: entry.status,
      timestamp: formatTransportTimestampSignature(entry.timestampMs),
      timestampMs: entry.timestampMs,
    },
    null,
    2,
  );
}

export interface TransportCorrelation {
  commandId: string | null;
  resourceKey: string;
  stageId: string | null;
}

export function resolveTransportCorrelation(
  entry: RequestDiagnosticEntry,
): TransportCorrelation {
  return {
    commandId: inferCommandId(entry),
    resourceKey: summarizeTransportPath(entry),
    stageId: inferStageId(entry),
  };
}

function inferCommandId(entry: RequestDiagnosticEntry): string | null {
  const match = entry.path.match(/\/simulation\/commands\/([^/?#]+)/);
  if (match?.[1]) {
    return decodeURIComponent(match[1]);
  }

  const detail = entry.detail ?? "";
  const detailMatch = detail.match(
    /\bcommand[_ -]?id["':= ]+([A-Za-z0-9_.:-]+)/i,
  );
  return detailMatch?.[1] ?? null;
}

function inferStageId(entry: RequestDiagnosticEntry): string | null {
  const detail = entry.detail ?? "";
  const match = detail.match(/\bstage[_ -]?id["':= ]+([A-Za-z0-9_.:-]+)/i);
  return match?.[1] ?? null;
}
