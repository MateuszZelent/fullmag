import type { CommandContext, CommandId } from "./commandTypes";

type CommandDiagnosticStatus =
  | "cancelled"
  | "completed"
  | "disabled"
  | "failed"
  | "missing"
  | "submitted";

export interface CommandDiagnosticEntry {
  commandId: CommandId;
  disabledReason: string | null;
  id: string;
  message: string | null;
  source: CommandContext["source"];
  sourceDetail: string | null;
  status: CommandDiagnosticStatus;
  timestampMs: number;
}

export interface CommandDiagnosticRecord {
  commandId: CommandId;
  disabledReason?: string | null;
  message?: string | null;
  source: CommandContext["source"];
  sourceDetail?: string | null;
  status: CommandDiagnosticStatus;
  timestampMs?: number;
}

type CommandDiagnosticListener = () => void;

export class CommandDiagnosticsController {
  private readonly entries: CommandDiagnosticEntry[] = [];
  private readonly listeners = new Set<CommandDiagnosticListener>();
  private newestFirstEntries: CommandDiagnosticEntry[] | null = null;
  private notificationQueued = false;
  private sequence = 0;
  private version = 0;

  constructor(private readonly maxEntries = 200) {}

  clear(): void {
    if (this.entries.length === 0) {
      return;
    }

    this.entries.length = 0;
    this.newestFirstEntries = null;
    this.schedulePublish();
  }

  getVersion(): number {
    return this.version;
  }

  list(): CommandDiagnosticEntry[] {
    return [...this.entries];
  }

  listNewestFirst(): CommandDiagnosticEntry[] {
    if (!this.newestFirstEntries) {
      this.newestFirstEntries = Object.freeze(
        [...this.entries].reverse(),
      ) as CommandDiagnosticEntry[];
    }

    return this.newestFirstEntries;
  }

  record(entry: CommandDiagnosticRecord): void {
    const timestampMs = entry.timestampMs ?? Date.now();
    this.entries.push({
      commandId: entry.commandId,
      disabledReason: entry.disabledReason ?? null,
      id: `${timestampMs}-${this.sequence++}`,
      message: entry.message ?? null,
      source: entry.source,
      sourceDetail: entry.sourceDetail ?? null,
      status: entry.status,
      timestampMs,
    });

    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }

    this.newestFirstEntries = null;
    this.schedulePublish();
  }

  subscribe(listener: CommandDiagnosticListener): () => void {
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
}
