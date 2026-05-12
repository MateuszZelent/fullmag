"use client";

import { fmtExpOrDash, fmtSIOrDash, fmtStepValue } from "@/lib/format";

interface LiveDockProps {
  workspaceStatus: string;
  effectiveStep: number;
  effectiveTime: number;
  effectiveDt: number;
  effectiveDmDt: number;
  stepsPerSec: number;
  hasSolverTelemetry: boolean;
}

export default function LiveDock({
  workspaceStatus,
  effectiveStep,
  effectiveTime,
  effectiveDt,
  effectiveDmDt,
  stepsPerSec,
  hasSolverTelemetry,
}: LiveDockProps) {
  return (
    <div className="rounded-md border border-border/30 bg-background/30 p-2 text-xs">
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="font-semibold text-foreground">Live</div>
        <div className="text-[0.65rem] uppercase tracking-[0.08em] text-muted-foreground">{workspaceStatus}</div>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[0.68rem]">
        <span className="text-muted-foreground">Step</span>
        <span className="font-mono text-foreground">{fmtStepValue(effectiveStep, hasSolverTelemetry)}</span>
        <span className="text-muted-foreground">Sim time</span>
        <span className="font-mono text-foreground">{fmtSIOrDash(effectiveTime, "s", hasSolverTelemetry)}</span>
        <span className="text-muted-foreground">dt</span>
        <span className="font-mono text-foreground">{fmtSIOrDash(effectiveDt, "s", hasSolverTelemetry)}</span>
        <span className="text-muted-foreground">max dm/dt</span>
        <span className="font-mono text-foreground">{fmtExpOrDash(effectiveDmDt, hasSolverTelemetry)}</span>
      </div>
      <div className="mt-1 text-[0.65rem] text-muted-foreground">
        Throughput: {stepsPerSec > 0 ? `${stepsPerSec.toFixed(1)} st/s` : "—"}
      </div>
    </div>
  );
}
