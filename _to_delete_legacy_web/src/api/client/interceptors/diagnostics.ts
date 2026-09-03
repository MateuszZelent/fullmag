/**
 * Diagnostics interceptor.
 * Logs every request/response to a diagnostic ring buffer for debugging.
 */

export interface DiagnosticEntry {
  requestId: string;
  method: string;
  url: string;
  startedAt: number;
  durationMs: number;
  status: number;
  payloadBytes: number | null;
  cacheHit: boolean;
  error: string | null;
}

const MAX_ENTRIES = 200;
const entries: DiagnosticEntry[] = [];

export function recordDiagnostic(entry: DiagnosticEntry): void {
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) {
    entries.shift();
  }
}

export function getDiagnostics(): readonly DiagnosticEntry[] {
  return entries;
}

export function clearDiagnostics(): void {
  entries.length = 0;
}

export function createDiagnosticEntry(
  requestId: string,
  method: string,
  url: string,
): { finish: (status: number, payloadBytes: number | null, cacheHit: boolean, error?: string | null) => void } {
  const startedAt = performance.now();
  return {
    finish(status: number, payloadBytes: number | null, cacheHit: boolean, error: string | null = null) {
      recordDiagnostic({
        requestId,
        method,
        url,
        startedAt,
        durationMs: Math.round(performance.now() - startedAt),
        status,
        payloadBytes,
        cacheHit,
        error,
      });
    },
  };
}
