"use client";

import { useMemo } from "react";
import {
  Activity, Clock, Cpu, HardDrive, Wifi, WifiOff,
  Loader2, CheckCircle2, XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface StatusBarProps {
  connection: "connecting" | "connected" | "disconnected";
  step: number;
  stepDisplay?: string;
  simTime: string;
  wallTime: string;
  throughput: string;
  backend: string;
  runtimeEngine?: string;
  runtimeGpuLabel?: string;
  precision: string;
  status: string;
  activityLabel?: string;
  activityDetail?: string;
  progressMode?: "idle" | "indeterminate" | "determinate";
  progressValue?: number | undefined;
  nodeCount?: string | number;
  commandMessage?: string | null;
  commandState?: "idle" | "progress" | "error" | "success" | "rejected";
  displayLabel?: string | null;
  displayDetail?: string | null;
  previewPending?: boolean;
  runtimeCanAcceptCommands?: boolean;
  pipelineLabel?: string | null;
  pipelineDetail?: string | null;
  pipelineProgressMode?: "idle" | "indeterminate" | "determinate";
  pipelineProgressValue?: number;
  stageLabel?: string | null;
  stageDetail?: string | null;
  stageProgressMode?: "idle" | "indeterminate" | "determinate";
  stageProgressValue?: number;
  eTotalSpark?: number[];
  dmDtSpark?: number[];
  dtSpark?: number[];
  hasSolverTelemetry?: boolean;
}

function Sparkline({
  values,
  stroke,
  title,
}: {
  values: number[];
  stroke: string;
  title: string;
}) {
  const points = useMemo(() => {
    if (values.length < 2) {
      return "";
    }
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = Math.max(max - min, 1e-12);
    return values
      .map((value, index) => {
        const x = (index / Math.max(values.length - 1, 1)) * 100;
        const y = 100 - ((value - min) / span) * 100;
        return `${x},${y}`;
      })
      .join(" ");
  }, [values]);

  return (
    <div className="flex items-center gap-1.5" title={title}>
      <svg viewBox="0 0 100 100" className="h-5 w-16 overflow-visible">
        <polyline
          fill="none"
          stroke={stroke}
          strokeWidth="6"
          strokeLinecap="round"
          strokeLinejoin="round"
          points={points}
        />
      </svg>
    </div>
  );
}

function FooterProgress({
  label,
  detail,
  mode,
  value,
  tone = "sky",
}: {
  label: string;
  detail?: string | null;
  mode: "idle" | "indeterminate" | "determinate";
  value?: number;
  tone?: "sky" | "emerald" | "amber";
}) {
  const width = mode === "determinate" ? Math.max(4, Math.min(100, value ?? 0)) : 38;
  const barClass =
    tone === "emerald"
      ? "bg-emerald-400"
      : tone === "amber"
        ? "bg-amber-400"
        : "bg-sky-400";
  return (
    <div className="flex min-w-[11rem] max-w-[15rem] flex-col gap-1">
      <div className="flex items-center justify-between gap-2 text-[0.6rem] uppercase tracking-[0.16em] text-muted-foreground">
        <span className="truncate">{label}</span>
        <span className="font-medium">
          {mode === "determinate" ? `${Math.round(value ?? 0)}%` : mode === "indeterminate" ? "..." : "—"}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-white/8">
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-300",
            barClass,
            mode === "indeterminate" && "animate-pulse",
          )}
          style={{ width: `${width}%` }}
        />
      </div>
      {detail ? (
        <div className="truncate text-[0.58rem] text-foreground/70" title={detail}>
          {detail}
        </div>
      ) : null}
    </div>
  );
}

function solverAcceleratorLabel(
  runtimeEngine?: string,
  runtimeGpuLabel?: string,
  backend?: string,
): "GPU" | "CPU" | null {
  const haystack = `${runtimeEngine ?? ""} ${runtimeGpuLabel ?? ""} ${backend ?? ""}`.toLowerCase();
  if (/(gpu|cuda)/.test(haystack)) {
    return "GPU";
  }
  if (/(cpu|reference)/.test(haystack)) {
    return "CPU";
  }
  return null;
}

export default function StatusBar({
  connection,
  step,
  stepDisplay,
  simTime,
  wallTime,
  backend,
  runtimeEngine,
  runtimeGpuLabel,
  precision,
  status,
  activityLabel,
  activityDetail,
  nodeCount,
  commandMessage,
  commandState,
  previewPending = false,
  runtimeCanAcceptCommands = false,
  pipelineLabel,
  pipelineDetail,
  pipelineProgressMode = "idle",
  pipelineProgressValue,
  stageLabel,
  stageDetail,
  stageProgressMode = "idle",
  stageProgressValue,
  eTotalSpark = [],
  dmDtSpark = [],
  dtSpark = [],
  hasSolverTelemetry = false,
}: StatusBarProps) {
  const solverAccelerator = solverAcceleratorLabel(runtimeEngine, runtimeGpuLabel, backend);
  return (
    <div className="flex items-center justify-between gap-3 border-t border-white/5 bg-background/60 px-3 py-1 text-[0.68rem] tracking-wide text-muted-foreground z-40 min-h-[26px]">
      <div className="flex items-center gap-2 overflow-hidden flex-1 min-w-0 mr-2">
        {(activityLabel || activityDetail) ? (
          <>
            <span className="font-medium text-[0.62rem] bg-primary/15 text-primary px-1.5 py-[1px] rounded border border-primary/20 shrink-0">
              {activityLabel ?? "Workspace"}
            </span>
            {activityDetail && (
              <span className="truncate max-w-full text-foreground/80 font-medium" title={activityDetail}>
                {activityDetail}
              </span>
            )}
          </>
        ) : (
          <span className="font-medium text-[0.62rem] bg-muted text-muted-foreground px-1.5 py-[1px] rounded shrink-0">
            Idle
          </span>
        )}
        {commandMessage && (
          <span
            className={cn(
              "max-w-[18rem] truncate rounded-full border px-2 py-0.5 text-[0.6rem] font-medium",
              commandState === "rejected"
                ? "border-rose-500/25 bg-rose-500/10 text-rose-300"
                : previewPending
                  ? "border-violet-500/25 bg-violet-500/10 text-violet-200"
                  : "border-sky-500/25 bg-sky-500/10 text-sky-300",
            )}
            title={commandMessage}
          >
            {commandMessage}
          </span>
        )}
      </div>
      <div className="flex items-center shrink-0 ml-auto gap-3">
        {(pipelineLabel || stageLabel) ? (
          <>
            {pipelineLabel ? (
              <FooterProgress
                label={pipelineLabel}
                detail={pipelineDetail}
                mode={pipelineProgressMode}
                value={pipelineProgressValue}
                tone="sky"
              />
            ) : null}
            {stageLabel ? (
              <FooterProgress
                label={stageLabel}
                detail={stageDetail}
                mode={stageProgressMode}
                value={stageProgressValue}
                tone="emerald"
              />
            ) : null}
          </>
        ) : null}

        <div className="flex items-center gap-2">
          {hasSolverTelemetry ? (
            <>
              <Sparkline values={eTotalSpark} stroke="#0ea5e9" title="E_total trend" />
              <Sparkline values={dmDtSpark} stroke="#89b4fa" title="max dm/dt trend" />
              <Sparkline values={dtSpark} stroke="#10b981" title="solver dt trend" />
            </>
          ) : (
            <span className="text-[0.6rem] text-muted-foreground/70">
              Charts waiting for live telemetry
            </span>
          )}
        </div>

        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span className={cn("flex items-center gap-1.5 font-medium text-muted-foreground", status === "running" && "text-primary", status === "completed" && "text-emerald-500", status === "failed" && "text-destructive")} data-status={status}>
              {status === "running" ? <Activity size={12} className="animate-spin" /> :
               status === "completed" ? <CheckCircle2 size={12} /> :
               status === "failed" ? <XCircle size={12} /> :
               <Loader2 size={12} />}
              {status}
            </span>
            <span className="h-3 w-px bg-border/50" />
            <span className="flex items-center gap-1.5" data-connection={connection}>
              {connection === "connected" ? <Wifi size={11} /> :
               connection === "connecting" ? <Loader2 size={11} className="animate-spin" /> :
               <WifiOff size={11} />}
              {connection}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1.5"><Clock size={11} />{simTime}</span>
            <span className="h-3 w-px bg-border/50" />
            <span>Step {stepDisplay ?? step.toLocaleString()}</span>
          </div>

          <div className="flex items-center gap-2">
            {nodeCount && (
              <>
                <span className="flex items-center gap-1.5"><HardDrive size={11} />{nodeCount}</span>
                <span className="h-3 w-px bg-border/50" />
              </>
            )}
            {solverAccelerator ? (
              <>
                <span className={cn(
                  "rounded-full border px-2 py-0.5 text-[0.58rem] font-bold uppercase tracking-[0.16em]",
                  solverAccelerator === "GPU"
                    ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-300"
                    : "border-primary/25 bg-primary/10 text-primary",
                )}>
                  Solver {solverAccelerator}
                </span>
                <span className="h-3 w-px bg-border/50" />
              </>
            ) : null}
            <span className={cn("font-medium text-[0.62rem]", runtimeCanAcceptCommands ? "text-emerald-400" : "text-muted-foreground/70")}>
              {runtimeCanAcceptCommands ? "Ready" : "Busy"}
            </span>
            <span className="h-3 w-px bg-border/50" />
            <span className="flex items-center gap-1.5"><Cpu size={11} />{runtimeEngine ? `${runtimeEngine}${runtimeGpuLabel ? ` · ${runtimeGpuLabel}` : ""} · ${precision}` : `${backend.toUpperCase()} · ${precision}`}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
