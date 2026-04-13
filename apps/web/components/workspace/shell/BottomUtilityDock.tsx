"use client";


import { cn } from "@/lib/utils";
import { fmtTime, fmtDuration, fmtStepValue, fmtSIOrDash, fmtExpOrDash } from "@/lib/format";
import type { ActivityInfo } from "@/components/runs/control-room/types";
import { DEFAULT_CONVERGENCE_THRESHOLD } from "@/components/panels/SolverSettingsPanel";

interface BottomTelemetryDockProps {
  activity: ActivityInfo | null;
  workspaceStatus: string;
  effectiveStep: number;
  effectiveTime: number;
  effectiveDt: number;
  effectiveDmDt: number;
  effectiveHEff: number;
  stepsPerSec: number;
  elapsed: number;
  hasSolverTelemetry: boolean;
  convergenceThreshold?: number;
  eTotal: number;
  /** Activity detail or solver stage label */
  activityDetail: string | null;
}

function fmtTimeOrDash(v: number, enabled: boolean): string {
  return enabled ? fmtTime(v) : "—";
}

export default function BottomTelemetryDock({
  activity,
  workspaceStatus,
  effectiveStep,
  effectiveTime,
  effectiveDt,
  effectiveDmDt,
  effectiveHEff,
  stepsPerSec,
  elapsed,
  hasSolverTelemetry,
  convergenceThreshold: convergenceThresholdProp,
  eTotal,
  activityDetail,
}: BottomTelemetryDockProps) {
  const convergenceThreshold = convergenceThresholdProp ?? DEFAULT_CONVERGENCE_THRESHOLD;

  const statusClassName =
    workspaceStatus === "completed"
      ? "text-emerald-500"
      : workspaceStatus === "running"
        ? "text-primary"
        : workspaceStatus === "materializing_script"
          ? "text-amber-500"
          : workspaceStatus === "failed"
            ? "text-destructive"
            : undefined;

  // Convergence metric
  const LOG_DECADES = 7;
  const dmDtLog = effectiveDmDt > 0 ? Math.log10(Math.max(effectiveDmDt, 1e-12)) : 0;
  const convergencePct = Math.max(0, Math.min(100, ((LOG_DECADES + dmDtLog) / LOG_DECADES) * 100));
  const convergenceDisplay = Math.max(0, Math.min(100, 100 - convergencePct));
  const convergenceTone =
    convergenceDisplay > 80 ? "success"
      : convergenceDisplay > 40 ? "warn"
      : "danger";

  return (
    <div className="flex h-full flex-col bg-card/35 isolate overflow-hidden relative z-40 border-t border-border/30">
      {/* ── Header ── */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border/15 bg-background/30">
        <span className="text-[0.62rem] font-bold uppercase tracking-[0.12em] text-muted-foreground/70">
          Telemetry
        </span>
        <span
          className={cn(
            "ml-1 text-[0.62rem] font-semibold uppercase tracking-wide",
            statusClassName ?? "text-muted-foreground",
          )}
        >
          {workspaceStatus}
        </span>
        {activityDetail && (
          <>
            <div className="h-3 w-px bg-border/30" />
            <span className="text-[0.6rem] text-muted-foreground/60 truncate max-w-[300px]">
              {activityDetail}
            </span>
          </>
        )}
      </div>

      {/* ── Telemetry grid ── */}
      <div className="flex-1 overflow-hidden">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-1.5 p-2">
          <div className="flex flex-col gap-0.5 p-2 rounded-md bg-card/20 shadow-sm border-l-[3px] border-l-sky-500">
            <span className="text-[0.58rem] font-semibold uppercase tracking-wider text-muted-foreground">Step</span>
            <span className="font-mono text-[0.78rem] font-semibold text-foreground">
              {fmtStepValue(effectiveStep, hasSolverTelemetry)}
            </span>
          </div>
          <div className="flex flex-col gap-0.5 p-2 rounded-md bg-card/20 shadow-sm border-l-[3px] border-l-violet-500">
            <span className="text-[0.58rem] font-semibold uppercase tracking-wider text-muted-foreground">Sim Time</span>
            <span className="font-mono text-[0.78rem] font-semibold text-foreground">
              {fmtTimeOrDash(effectiveTime, hasSolverTelemetry)}
            </span>
          </div>
          <div className="flex flex-col gap-0.5 p-2 rounded-md bg-card/20 shadow-sm border-l-[3px] border-l-amber-500">
            <span className="text-[0.58rem] font-semibold uppercase tracking-wider text-muted-foreground">Δt</span>
            <span className="font-mono text-[0.78rem] font-semibold text-foreground">
              {fmtSIOrDash(effectiveDt, "s", hasSolverTelemetry)}
            </span>
          </div>
          <div className="flex flex-col gap-0.5 p-2 rounded-md bg-card/20 shadow-sm border-l-[3px] border-l-emerald-500">
            <span className="text-[0.58rem] font-semibold uppercase tracking-wider text-muted-foreground">max dm/dt</span>
            <span
              className={cn(
                "font-mono text-[0.78rem] font-semibold text-foreground",
                hasSolverTelemetry && effectiveDmDt < convergenceThreshold && "text-emerald-500",
              )}
            >
              {fmtExpOrDash(effectiveDmDt, hasSolverTelemetry)}
            </span>
          </div>
          <div className="flex flex-col gap-0.5 p-2 rounded-md bg-card/20 shadow-sm border-l-[3px] border-l-rose-500">
            <span className="text-[0.58rem] font-semibold uppercase tracking-wider text-muted-foreground">max |H_eff|</span>
            <span className="font-mono text-[0.78rem] font-semibold text-foreground">
              {fmtExpOrDash(effectiveHEff, hasSolverTelemetry)}
            </span>
          </div>
          <div className="flex flex-col gap-0.5 p-2 rounded-md bg-card/20 shadow-sm border-l-[3px] border-l-indigo-500">
            <span className="text-[0.58rem] font-semibold uppercase tracking-wider text-muted-foreground">E_total</span>
            <span className="font-mono text-[0.78rem] font-semibold text-foreground">
              {fmtSIOrDash(eTotal, "J", hasSolverTelemetry)}
            </span>
          </div>
          <div className="flex flex-col gap-0.5 p-2 rounded-md bg-card/20 shadow-sm border-l-[3px] border-l-slate-400">
            <span className="text-[0.58rem] font-semibold uppercase tracking-wider text-muted-foreground">Elapsed</span>
            <span className="font-mono text-[0.78rem] font-semibold text-foreground">{fmtDuration(elapsed)}</span>
          </div>
          <div className="flex flex-col gap-0.5 p-2 rounded-md bg-card/20 shadow-sm border-l-[3px] border-l-orange-500">
            <span className="text-[0.58rem] font-semibold uppercase tracking-wider text-muted-foreground">Throughput</span>
            <span className="font-mono text-[0.78rem] font-semibold text-foreground">
              {stepsPerSec > 0 ? `${stepsPerSec.toFixed(1)} st/s` : "—"}
            </span>
          </div>

          {/* Convergence bar — spans full row */}
          <div className="flex items-center gap-2 p-2 rounded-md bg-card/20 shadow-sm col-span-full border-l-[3px] border-l-primary/50">
            <span className="text-[0.58rem] font-semibold uppercase tracking-wider text-muted-foreground shrink-0 w-[70px]">Convergence</span>
            <progress
              className="w-full h-1.5 rounded-full overflow-hidden bg-muted appearance-none fill-primary [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:bg-primary [&::-moz-progress-bar]:bg-primary data-[tone=success]:[&::-webkit-progress-value]:bg-emerald-500 data-[tone=warn]:[&::-webkit-progress-value]:bg-amber-500 data-[tone=danger]:[&::-webkit-progress-value]:bg-destructive"
              value={convergenceDisplay}
              max={100}
              data-tone={convergenceTone}
            />
            <span className="font-mono text-[0.62rem] font-semibold text-muted-foreground shrink-0 w-[40px] text-right">
              {convergenceDisplay.toFixed(0)}%
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
