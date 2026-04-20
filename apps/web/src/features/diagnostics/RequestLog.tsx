"use client";

import { useMemo } from "react";

import { readDiagnosticEntries } from "./DiagnosticStore";

export function RequestLog() {
  const entries = useMemo(() => [...readDiagnosticEntries()].reverse(), []);

  return (
    <div className="rounded-lg border border-border/40 bg-background/70 p-3">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Request Log
      </div>
      <div className="space-y-2 text-xs">
        {entries.length === 0 ? (
          <div className="text-muted-foreground">No requests recorded yet.</div>
        ) : (
          entries.map((entry) => (
            <div
              key={`${entry.requestId}:${entry.startedAt}`}
              className="rounded border border-border/30 px-2 py-1"
            >
              <div className="font-medium">
                {entry.method} {entry.status} {entry.url}
              </div>
              <div className="text-muted-foreground">
                {entry.durationMs} ms
                {entry.payloadBytes != null ? ` • ${entry.payloadBytes} B` : ""}
                {entry.cacheHit ? " • cache" : ""}
                {entry.error ? ` • ${entry.error}` : ""}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
