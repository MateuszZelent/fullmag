"use client";

import type { EngineLogEntry } from "@/lib/session/types";

interface LogDockProps {
  engineLog: EngineLogEntry[];
}

export default function LogDock({ engineLog }: LogDockProps) {
  const tail = engineLog.slice(-6);
  return (
    <div className="rounded-md border border-border/30 bg-background/30 p-2 text-xs">
      <div className="font-semibold text-foreground">Log</div>
      <div className="mt-1 flex flex-col gap-1">
        {tail.length === 0 ? (
          <span className="text-muted-foreground">No log entries.</span>
        ) : (
          tail.map((entry, index) => (
            <span key={`${entry.timestamp_unix_ms}-${index}`} className="font-mono text-[0.65rem] text-muted-foreground">
              {entry.message}
            </span>
          ))
        )}
      </div>
    </div>
  );
}
