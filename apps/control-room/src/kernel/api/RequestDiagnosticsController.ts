export type RequestOutcome = "ok" | "error" | "network-error" | "aborted";

export interface RequestDiagnosticEntry {
  durationMs: number;
  method: string;
  outcome: RequestOutcome;
  path: string;
  requestId: string;
  status: number | null;
}

export class RequestDiagnosticsController {
  private readonly entries: RequestDiagnosticEntry[] = [];

  constructor(private readonly maxEntries = 50) {}

  record(entry: RequestDiagnosticEntry): void {
    this.entries.push(entry);

    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }
  }

  list(): RequestDiagnosticEntry[] {
    return [...this.entries];
  }
}
