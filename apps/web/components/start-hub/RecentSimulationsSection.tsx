"use client";

import { useState } from "react";
import { FileCode2, FlaskConical, History, Layout, MonitorCheck } from "lucide-react";
import type { RecentSimulationEntry } from "@/lib/workspace/recent-simulations";
import { fmtDuration } from "@/lib/format";

interface RecentSimulationsSectionProps {
  entries: RecentSimulationEntry[];
  onOpenRecent: (entry: RecentSimulationEntry) => void;
}

export default function RecentSimulationsSection({
  entries,
  onOpenRecent,
}: RecentSimulationsSectionProps) {
  const [now] = useState(() => Date.now());

  return (
    <div className="flex flex-col gap-3">
      {entries.length === 0 ? (
        <div className="flex min-h-36 flex-col items-center justify-center rounded-md border border-dashed border-border/70 bg-background/35 p-6 text-center">
          <History className="mb-3 h-7 w-7 text-muted-foreground/60" />
          <div className="text-sm font-medium text-muted-foreground">
            No session history
          </div>
        </div>
      ) : (
        entries.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => onOpenRecent(entry)}
            className="group flex flex-col gap-3 rounded-md border border-border/60 bg-background/35 p-4 text-left transition-colors hover:border-primary/35 hover:bg-secondary/40"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border/60 bg-card/80">
                  {entry.kind === "project" ? (
                    <Layout className="h-4.5 w-4.5 text-primary/70" />
                  ) : entry.kind === "script" ? (
                    <FileCode2 className="h-4.5 w-4.5 text-viewport-violet" />
                  ) : (
                    <FlaskConical className="h-4.5 w-4.5 text-viewport-amber" />
                  )}
                </div>
                <div className="flex flex-col min-w-0">
                  <span className="truncate text-sm font-semibold tracking-tight text-foreground transition-colors group-hover:text-primary">
                    {entry.name}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {entry.path.split("/").pop()}
                  </span>
                </div>
              </div>
              
              <div className="mt-1 h-2 w-2 rounded-full bg-primary/60" />
            </div>

            <div className="grid grid-cols-3 gap-2 border-t border-border/60 pt-3">
              <div className="flex flex-col gap-0.5">
                <span className="text-xs font-medium text-muted-foreground">Backend</span>
                <span className="truncate text-xs font-semibold uppercase text-foreground/80">
                  {entry.backend ?? "Auto"}
                </span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-xs font-medium text-muted-foreground">Modified</span>
                <span className="truncate text-xs font-semibold uppercase text-foreground/80">
                  {fmtDuration(Math.max(0, now - entry.updatedAtUnixMs))} ago
                </span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-xs font-medium text-muted-foreground">Stage</span>
                <span className="truncate text-xs font-semibold uppercase text-primary">
                  {entry.lastStage ?? "Build"}
                </span>
              </div>
            </div>

            <div className="flex items-center gap-2 rounded-md border border-border/60 bg-card/60 px-2.5 py-1.5">
              <MonitorCheck className="h-3.5 w-3.5 text-success" />
              <span className="text-xs font-medium text-muted-foreground">
                Deployment Ready
              </span>
            </div>
          </button>
        ))
      )}
    </div>
  );
}
