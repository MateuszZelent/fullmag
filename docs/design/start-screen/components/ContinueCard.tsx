"use client";

/**
 * The interrupted run, offered first because resuming is the most likely intent
 * on launch.
 *
 * Rule: never render a button that will fail. When the checkpoint is not
 * resumable on this machine, the primary action is removed and the reason takes
 * the place of the ETA line.
 *
 * Reference implementation — intended to live at
 * apps/control-room/src/modules/start/home/ContinueCard.tsx
 */

import { FolderOpen, Play, Trash2 } from "lucide-react";

import { Button } from "@/shared/ui/Button";
import { cn } from "@/shared/utils/className";

import { StatusPill } from "./ProjectBadges";
import { formatEta } from "./recentIndex";
import type { ContinueSession, RecentEntry } from "./types";

export interface ContinueCardProps {
  readonly session: ContinueSession;
  readonly entry: RecentEntry;
  readonly onResume: (projectId: string, runId: string) => void;
  readonly onOpen: (projectId: string) => void;
  readonly onDiscard: (projectId: string, runId: string) => void;
}

export function ContinueCard({ session, entry, onResume, onOpen, onDiscard }: ContinueCardProps) {
  const pct = Math.round(session.progress.fraction * 100);
  const eta = formatEta(session.progress.etaSeconds);
  const { framesWritten, framesTotal, simTimeS, simTimeTotalS } = session.progress;

  const timeLabel =
    simTimeS != null && simTimeTotalS != null
      ? `paused at t = ${formatSimTime(simTimeS)} / ${formatSimTime(simTimeTotalS)}`
      : "paused";

  const frameLabel =
    framesWritten != null && framesTotal != null ? `${framesWritten} / ${framesTotal} frames` : null;

  return (
    <section
      aria-labelledby="fm-continue-heading"
      className={cn(
        "relative flex gap-fm-4 overflow-hidden rounded-fm-lg border border-fm-subtle",
        "bg-fm-surface p-fm-3 shadow-fm-sm",
        // The one accent wash on the page. It is what makes this read as
        // "the thing to do" without a coloured border or a badge.
        "after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit]",
        "after:bg-[linear-gradient(100deg,color-mix(in_srgb,var(--fm-accent)_7%,transparent),transparent_42%)]",
      )}
      data-slot="continue-card"
    >
      <div className="relative h-[110px] w-[176px] shrink-0 overflow-hidden rounded-fm-md border border-fm-subtle bg-fm-canvas">
        {entry.thumbnail && (
          <img alt="" className="size-full object-cover" src={entry.thumbnail} />
        )}
      </div>

      <div className="relative z-[1] flex min-w-0 flex-1 flex-col">
        <h3
          className="mb-0.5 truncate font-fm-ui text-fm-lg font-semibold tracking-[-0.005em]"
          id="fm-continue-heading"
        >
          {entry.name}
        </h3>
        <p className="mb-fm-3 truncate font-fm-mono text-fm-2xs text-fm-muted" title={entry.path}>
          {entry.path}
        </p>

        <div className="mb-fm-3 flex flex-wrap items-center gap-x-fm-3 gap-y-fm-2">
          <StatusPill label={timeLabel} status="running" />

          <div
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={pct}
            aria-valuetext={eta ? `${pct} percent, ${eta} remaining` : `${pct} percent`}
            className="h-[5px] min-w-[80px] flex-1 overflow-hidden rounded-full bg-fm-raised"
            role="progressbar"
          >
            <div
              className="h-full rounded-full bg-[linear-gradient(90deg,var(--fm-chart-yellow),var(--fm-chart-peach))] transition-[width] duration-[240ms]"
              style={{ width: `${pct}%` }}
            />
          </div>

          <span className="min-w-[34px] text-right font-fm-mono text-fm-xs text-fm-secondary">
            {pct}%
          </span>

          {session.resumable ? (
            <span className="whitespace-nowrap font-fm-ui text-fm-xs text-fm-muted">
              {[eta, frameLabel].filter(Boolean).join(" · ")}
            </span>
          ) : (
            <span className="font-fm-ui text-fm-xs text-fm-warning">
              {session.notResumableReason ?? "This checkpoint cannot be resumed by this build."}
            </span>
          )}
        </div>

        <div className="mt-auto flex gap-fm-2">
          {session.resumable && (
            <Button onClick={() => onResume(session.projectId, session.runId)} type="button" variant="primary">
              <Play aria-hidden="true" className="size-3.5" />
              Resume run
            </Button>
          )}
          <Button onClick={() => onOpen(session.projectId)} type="button" variant="secondary">
            <FolderOpen aria-hidden="true" className="size-3.5" />
            Open project
          </Button>
          <Button onClick={() => onDiscard(session.projectId, session.runId)} type="button" variant="ghost">
            <Trash2 aria-hidden="true" className="size-3.5" />
            Discard checkpoint
          </Button>
        </div>
      </div>
    </section>
  );
}

/** Simulated time is always sub-microsecond here; ns is the useful unit. */
function formatSimTime(seconds: number): string {
  const ns = seconds * 1e9;
  if (ns < 1) return `${(ns * 1e3).toFixed(1)} ps`;
  if (ns < 1000) return `${ns.toFixed(2)} ns`;
  return `${(ns / 1e3).toFixed(2)} µs`;
}
