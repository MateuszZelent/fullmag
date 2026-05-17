type RequestOutcome = "ok" | "error" | "network-error" | "aborted";
export type TransportChannel = "http" | "websocket";
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

type RequestDiagnosticListener = () => void;

export class RequestDiagnosticsController {
  private readonly entries: RequestDiagnosticEntry[] = [];
  private readonly listeners = new Set<RequestDiagnosticListener>();
  private sequence = 0;
  private version = 0;

  constructor(private readonly maxEntries = 200) {}

  clear(): void {
    if (this.entries.length === 0) {
      return;
    }

    this.entries.length = 0;
    this.publish();
  }

  getVersion(): number {
    return this.version;
  }

  record(entry: RequestDiagnosticRecord): void {
    const timestampMs = entry.timestampMs ?? Date.now();
    this.entries.push({
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
    });

    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }

    this.publish();
  }

  list(): RequestDiagnosticEntry[] {
    return [...this.entries];
  }

  subscribe(listener: RequestDiagnosticListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private publish(): void {
    this.version += 1;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

function normalizeByteLength(byteLength: number | null | undefined): number | null {
  if (typeof byteLength !== "number" || !Number.isFinite(byteLength)) {
    return null;
  }

  return Math.max(0, Math.round(byteLength));
}
