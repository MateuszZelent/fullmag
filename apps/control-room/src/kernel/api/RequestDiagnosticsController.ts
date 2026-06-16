import { diagnosticsSummaryIntervalMs } from "../realtime/communicationPolicy";

type RequestOutcome = "ok" | "error" | "network-error" | "aborted";
export type TransportChannel = "http" | "performance" | "websocket";
export type TransportDirection = "rx" | "tx";
type TransportOutcome = RequestOutcome | "sent";

export interface RequestDiagnosticEntry {
  byteLength: number | null;
  channel: TransportChannel;
  contentType: string | null;
  detail: string | null;
  direction: TransportDirection;
  durationMs: number | null;
  id: string;
  messageType: string | null;
  method: string;
  outcome: TransportOutcome;
  path: string;
  requestId: string;
  status: number | null;
  timestampMs: number;
}

export interface RequestDiagnosticRecord {
  byteLength?: number | null;
  channel?: TransportChannel;
  contentType?: string | null;
  detail?: string | null;
  direction?: TransportDirection;
  durationMs?: number | null;
  messageType?: string | null;
  method: string;
  outcome: TransportOutcome;
  path: string;
  requestId: string;
  status?: number | null;
  timestampMs?: number;
}

export interface RequestDiagnosticsStats {
  byteLength: number;
  entryCount: number;
  maxEntries: number;
}

type RequestDiagnosticListener = () => void;

interface AggregatedTransportDiagnostic {
  count: number;
  firstTimestampMs: number;
  signature: string;
}

export class RequestDiagnosticsController {
  private readonly entries: RequestDiagnosticEntry[] = [];
  private readonly aggregatedEntries = new Map<string, AggregatedTransportDiagnostic>();
  private readonly listeners = new Set<RequestDiagnosticListener>();
  private newestFirstEntries: RequestDiagnosticEntry[] | null = null;
  private notificationQueued = false;
  private sequence = 0;
  private version = 0;

  constructor(private readonly maxEntries = 200) {}

  clear(): void {
    if (this.entries.length === 0) {
      return;
    }

    this.entries.length = 0;
    this.aggregatedEntries.clear();
    this.newestFirstEntries = null;
    this.schedulePublish();
  }

  getVersion(): number {
    return this.version;
  }

  record(entry: RequestDiagnosticRecord): void {
    const timestampMs = entry.timestampMs ?? Date.now();
    const normalizedEntry = {
      byteLength: normalizeByteLength(entry.byteLength),
      channel: entry.channel ?? "http",
      contentType: entry.contentType ?? null,
      detail: entry.detail ?? null,
      direction: entry.direction ?? "rx",
      durationMs: entry.durationMs ?? null,
      id: `${timestampMs}-${this.sequence++}`,
      messageType: entry.messageType ?? null,
      method: entry.method,
      outcome: entry.outcome,
      path: entry.path,
      requestId: entry.requestId,
      status: entry.status ?? null,
      timestampMs,
    };

    if (this.mergeAggregatedEntry(normalizedEntry)) {
      this.newestFirstEntries = null;
      this.schedulePublish();
      return;
    }

    this.entries.push(normalizedEntry);

    if (this.entries.length > this.maxEntries) {
      const removed = this.entries.splice(0, this.entries.length - this.maxEntries);
      for (const item of removed) {
        this.aggregatedEntries.delete(item.id);
      }
    }

    this.newestFirstEntries = null;
    this.schedulePublish();
  }

  list(): RequestDiagnosticEntry[] {
    return [...this.entries];
  }

  listNewestFirst(): RequestDiagnosticEntry[] {
    if (!this.newestFirstEntries) {
      this.newestFirstEntries = Object.freeze(
        [...this.entries].reverse(),
      ) as RequestDiagnosticEntry[];
    }

    return this.newestFirstEntries;
  }

  stats(): RequestDiagnosticsStats {
    return {
      byteLength: this.entries.reduce(
        (total, entry) => total + estimateDiagnosticEntryByteLength(entry),
        0,
      ),
      entryCount: this.entries.length,
      maxEntries: this.maxEntries,
    };
  }

  subscribe(listener: RequestDiagnosticListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private schedulePublish(): void {
    if (this.notificationQueued) {
      return;
    }

    this.notificationQueued = true;
    queueMicrotask(() => {
      this.notificationQueued = false;
      this.version += 1;
      for (const listener of this.listeners) {
        listener();
      }
    });
  }

  private mergeAggregatedEntry(entry: RequestDiagnosticEntry): boolean {
    const signature = aggregatedTransportSignature(entry);
    if (!signature) return false;

    const existing = this.findAggregatedEntry(signature);
    if (existing) {
      const { aggregate, entry: previous, index } = existing;
      const windowMs = diagnosticsSummaryIntervalMs();
      if (entry.timestampMs - aggregate.firstTimestampMs >= windowMs) {
        this.aggregatedEntries.set(entry.id, {
          count: 1,
          firstTimestampMs: entry.timestampMs,
          signature,
        });
        return false;
      }
      aggregate.count += 1;
      previous.byteLength = addNullableByteLengths(previous.byteLength, entry.byteLength);
      previous.detail = aggregateDiagnosticDetail(
        entry.detail,
        aggregate.count,
        entry.timestampMs - aggregate.firstTimestampMs,
      );
      previous.durationMs = addNullableDurations(previous.durationMs, entry.durationMs);
      previous.timestampMs = entry.timestampMs;
      if (index !== this.entries.length - 1) {
        this.entries.splice(index, 1);
        this.entries.push(previous);
      }
      return true;
    }

    this.aggregatedEntries.set(entry.id, {
      count: 1,
      firstTimestampMs: entry.timestampMs,
      signature,
    });
    return false;
  }

  private findAggregatedEntry(
    signature: string,
  ): {
    aggregate: AggregatedTransportDiagnostic;
    entry: RequestDiagnosticEntry;
    index: number;
  } | null {
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const entry = this.entries[index];
      const aggregate = this.aggregatedEntries.get(entry.id);
      if (aggregate?.signature === signature) {
        return { aggregate, entry, index };
      }
    }

    return null;
  }
}

function estimateDiagnosticEntryByteLength(entry: RequestDiagnosticEntry): number {
  return (
    96 +
    estimateStringByteLength(entry.contentType) +
    estimateStringByteLength(entry.detail) +
    estimateStringByteLength(entry.id) +
    estimateStringByteLength(entry.messageType) +
    estimateStringByteLength(entry.method) +
    estimateStringByteLength(entry.outcome) +
    estimateStringByteLength(entry.path) +
    estimateStringByteLength(entry.requestId)
  );
}

function estimateStringByteLength(value: string | null): number {
  return value ? value.length * 2 : 0;
}

function normalizeByteLength(byteLength: number | null | undefined): number | null {
  if (typeof byteLength !== "number" || !Number.isFinite(byteLength)) {
    return null;
  }

  return Math.max(0, Math.round(byteLength));
}

function aggregatedTransportSignature(entry: RequestDiagnosticEntry): string | null {
  if (entry.outcome === "aborted") {
    return null;
  }

  return [
    entry.channel,
    entry.direction,
    entry.method,
    entry.outcome,
    entry.path,
    entry.status ?? "",
    entry.messageType ?? "",
    entry.detail ?? "",
  ].join("|");
}

function aggregateDiagnosticDetail(
  latestDetail: string | null,
  count: number,
  elapsedMs: number,
): string {
  const prefix = latestDetail ?? "message";
  return `${prefix} (x${count} over ${Math.max(0, Math.round(elapsedMs))}ms)`;
}

function addNullableByteLengths(
  left: number | null,
  right: number | null,
): number | null {
  if (left === null && right === null) return null;
  return (left ?? 0) + (right ?? 0);
}

function addNullableDurations(
  left: number | null,
  right: number | null,
): number | null {
  if (left === null && right === null) return null;
  return (left ?? 0) + (right ?? 0);
}
