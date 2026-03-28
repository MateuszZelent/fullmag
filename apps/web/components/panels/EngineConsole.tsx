"use client";

import { useRef, useEffect, useState, useMemo } from "react";
import type { LiveState, ScalarRow, SessionManifest, RunManifest, ArtifactEntry, EngineLogEntry } from "../../lib/useSessionStream";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Play, Settings, Loader2, Pause, Circle, Diamond,
  ArrowRight, CheckCircle2, XCircle, AlertTriangle, Dot,
} from "lucide-react";
import { cn } from "@/lib/utils";
import ScalarPlot from "../plots/ScalarPlot";
import ScalarTable from "./ScalarTable";

/* ── Types ─────────────────────────────────────────────────── */

type ConsoleTab = "live" | "log" | "energy" | "charts" | "table" | "progress" | "perf";
type ChartPreset = "energy" | "magnetization" | "convergence" | "timestep" | "all";

const CHART_PRESETS: Record<ChartPreset, { label: string; yColumns: string[] }> = {
  energy:       { label: "Energy",       yColumns: ["e_ex", "e_demag", "e_ext", "e_total"] },
  magnetization:{ label: "M avg",        yColumns: ["mx", "my", "mz"] },
  convergence:  { label: "Convergence",  yColumns: ["max_dm_dt", "max_h_eff"] },
  timestep:     { label: "Δt",           yColumns: ["solver_dt"] },
  all:          { label: "All",          yColumns: ["e_total", "max_dm_dt", "solver_dt", "max_h_eff"] },
};

interface EngineConsoleProps {
  session: SessionManifest | null;
  run: RunManifest | null;
  liveState: LiveState | null;
  scalarRows: ScalarRow[];
  engineLog: EngineLogEntry[];
  artifacts: ArtifactEntry[];
  connection: "connecting" | "connected" | "disconnected";
  error: string | null;
  presentationMode?: "session" | "current";
}

/* ── Formatting ────────────────────────────────────────────── */

function fmtSI(v: number, unit: string): string {
  if (!Number.isFinite(v) || v === 0) return `0 ${unit}`;
  const abs = Math.abs(v);
  if (abs >= 1e12) return `${(v / 1e12).toPrecision(3)} T${unit}`;
  if (abs >= 1e9) return `${(v / 1e9).toPrecision(3)} G${unit}`;
  if (abs >= 1e6) return `${(v / 1e6).toPrecision(3)} M${unit}`;
  if (abs >= 1e3) return `${(v / 1e3).toPrecision(3)} k${unit}`;
  if (abs >= 1) return `${v.toPrecision(3)} ${unit}`;
  if (abs >= 1e-3) return `${(v * 1e3).toPrecision(3)} m${unit}`;
  if (abs >= 1e-6) return `${(v * 1e6).toPrecision(3)} µ${unit}`;
  if (abs >= 1e-9) return `${(v * 1e9).toPrecision(3)} n${unit}`;
  if (abs >= 1e-12) return `${(v * 1e12).toPrecision(3)} p${unit}`;
  return `${v.toExponential(2)} ${unit}`;
}

function fmtTime(t: number): string {
  if (t === 0) return "0 s";
  return fmtSI(t, "s");
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 3600000) return `${(ms / 60000).toFixed(1)} min`;
  return `${(ms / 3600000).toFixed(2)} h`;
}

function fmtExp(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (v === 0) return "0";
  return v.toExponential(3);
}

function fmtStepValue(v: number, enabled: boolean): string {
  return enabled ? v.toLocaleString() : "—";
}

function fmtTimeOrDash(v: number, enabled: boolean): string {
  return enabled ? fmtTime(v) : "—";
}

function fmtSIOrDash(v: number, unit: string, enabled: boolean): string {
  return enabled ? fmtSI(v, unit) : "—";
}

function fmtExpOrDash(v: number, enabled: boolean): string {
  return enabled ? fmtExp(v) : "—";
}

/* ── Log entry type ────────────────────────────────────────── */

interface LogEntry {
  time: number;
  icon: React.ReactNode;
  message: string;
  severity: "info" | "success" | "warn" | "error" | "system";
}

function buildLogEntries(
  session: SessionManifest | null,
  run: RunManifest | null,
  liveState: LiveState | null,
  scalarRows: ScalarRow[],
  engineLog: EngineLogEntry[],
  connection: string,
  error: string | null,
  presentationMode: "session" | "current",
): LogEntry[] {
  const entries: LogEntry[] = [];
  const now = Date.now();
  const hasEngineLog = engineLog.length > 0;
  const workspaceStatus = liveState?.status ?? session?.status ?? run?.status ?? "idle";

  if (session) {
    if (!hasEngineLog) {
      entries.push({
        time: session.started_at_unix_ms,
        icon: <Play size={12} />,
        message:
          presentationMode === "current"
            ? `Workspace started — ${session.problem_name}`
            : `Session ${session.session_id.slice(0, 8)} started — ${session.problem_name}`,
        severity: "system",
      });

      if (session.requested_backend) {
        entries.push({
          time: session.started_at_unix_ms + 1,
          icon: <Settings size={12} />,
          message: `Backend: ${session.requested_backend.toUpperCase()} · Mode: ${session.execution_mode} · Precision: ${session.precision}`,
          severity: "info",
        });
      }

      const phaseMessage = (() => {
        if (workspaceStatus === "materializing_script") {
          return {
            icon: <Loader2 size={12} />,
            message: "Materializing script, importing geometry, and preparing the execution plan",
            severity: "system" as const,
          };
        }
        if (workspaceStatus === "awaiting_command") {
          return {
            icon: <Pause size={12} />,
            message: "Workspace is waiting for the next interactive command",
            severity: "system" as const,
          };
        }
        if (workspaceStatus === "running") {
          return {
            icon: <Circle size={12} />,
            message: "Solver is running and publishing live state",
            severity: "system" as const,
          };
        }
        return null;
      })();
      if (phaseMessage) {
        entries.push({
          time: session.started_at_unix_ms + 1,
          ...phaseMessage,
        });
      }
    }

    const plan = session.plan_summary as Record<string, unknown> | undefined;
    if (plan) {
      const parts: string[] = [];
      if (plan.n_nodes) parts.push(`${(plan.n_nodes as number).toLocaleString()} nodes`);
      if (plan.n_elements) parts.push(`${(plan.n_elements as number).toLocaleString()} elements`);
      if (plan.grid_cells) {
        const g = plan.grid_cells as number[];
        parts.push(`grid ${g[0]}×${g[1]}×${g[2]}`);
      }
      if (parts.length > 0) {
        entries.push({
          time: session.started_at_unix_ms + 2,
          icon: <Diamond size={12} />,
          message: `Mesh: ${parts.join(" · ")}`,
          severity: "info",
        });
      }
    }
  }

  if (engineLog.length > 0) {
    for (const entry of engineLog) {
      entries.push({
        time: entry.timestamp_unix_ms,
        icon:
          entry.level === "error" ? <XCircle size={12} />
            : entry.level === "warn" ? <AlertTriangle size={12} />
            : entry.level === "success" ? <CheckCircle2 size={12} />
            : entry.level === "system" ? <Diamond size={12} />
            : <Dot size={12} />,
        message: entry.message,
        severity:
          entry.level === "error" ? "error"
            : entry.level === "warn" ? "warn"
            : entry.level === "success" ? "success"
            : entry.level === "system" ? "system"
            : "info",
      });
    }
  }

  // Solver progress milestones
  const milestones = [1, 10, 50, 100, 500, 1000, 5000, 10000];
  for (const m of milestones) {
    const row = scalarRows.find((r) => r.step === m);
    if (row) {
      entries.push({
        time: session ? session.started_at_unix_ms + m : now,
        icon: <ArrowRight size={12} />,
        message: `Step ${m}: t=${fmtTime(row.time)} dt=${fmtExp(row.solver_dt)} max_dm/dt=${fmtExp(row.max_dm_dt)}`,
        severity: "info",
      });
    }
  }

  // Current live state
  if (liveState && liveState.step > 0) {
    entries.push({
      time: liveState.updated_at_unix_ms || now,
      icon: <Circle size={12} />,
      message: `Live: step=${liveState.step} t=${fmtTime(liveState.time)} dt=${fmtExp(liveState.dt)} max_dm/dt=${fmtExp(liveState.max_dm_dt)}`,
      severity: "system",
    });
  }

  // Convergence check — threshold matches the default torque_tolerance
  // in ProblemIR::Relaxation. Shows only when solver is clearly approaching
  // equilibrium (step > 10 avoids false positive on initial conditions).
  const CONVERGENCE_THRESHOLD = 1e-5;
  if (liveState && liveState.max_dm_dt < CONVERGENCE_THRESHOLD && liveState.step > 10) {
    entries.push({
      time: liveState.updated_at_unix_ms || now,
      icon: <CheckCircle2 size={12} />,
      message: `Convergence criterion: max_dm/dt = ${fmtExp(liveState.max_dm_dt)} < ${CONVERGENCE_THRESHOLD.toExponential(0)} — approaching equilibrium`,
      severity: "success",
    });
  }

  // Completion / failure
  if (run?.status === "completed") {
    entries.push({
      time: session?.finished_at_unix_ms ?? now,
      icon: <CheckCircle2 size={12} />,
      message: `Run completed — ${run.total_steps} steps in ${fmtDuration((session?.finished_at_unix_ms ?? 0) - (session?.started_at_unix_ms ?? 0))}`,
      severity: "success",
    });
  }
  if (run?.status === "failed" || error) {
    entries.push({
      time: now,
      icon: <XCircle size={12} />,
      message: error ? `Error: ${error}` : "Run failed",
      severity: "error",
    });
  }

  // Connection status
  if (connection === "disconnected") {
    entries.push({
      time: now,
      icon: <AlertTriangle size={12} />,
      message:
        presentationMode === "current"
          ? "Live connection lost — attempting reconnect…"
          : "SSE connection lost — attempting reconnect…",
      severity: "warn",
    });
  }

  entries.sort((a, b) => a.time - b.time);
  return entries;
}

/* ── Component ─────────────────────────────────────────────── */

const TABS: { value: ConsoleTab; label: string }[] = [
  { value: "live", label: "Live" },
  { value: "log", label: "Log" },
  { value: "energy", label: "Energy" },
  { value: "charts", label: "Charts" },
  { value: "table", label: "Table" },
  { value: "progress", label: "Progress" },
  { value: "perf", label: "Perf" },
];

export default function EngineConsole({
  session,
  run,
  liveState,
  scalarRows,
  engineLog,
  artifacts,
  connection,
  error,
  presentationMode = "current",
}: EngineConsoleProps) {
  const [activeTab, setActiveTab] = useState<ConsoleTab>("live");
  const [chartPreset, setChartPreset] = useState<ChartPreset>("energy");
  /* Note: we keep state manually for backwards compat; Radix Tabs controlled via value/onValueChange */
  const logContainerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  const logEntries = useMemo(
    () => buildLogEntries(session, run, liveState, scalarRows, engineLog, connection, error, presentationMode),
    [session, run, liveState, scalarRows, engineLog, connection, error, presentationMode],
  );

  const workspaceStatus = liveState?.status ?? session?.status ?? run?.status ?? "idle";

  useEffect(() => {
    if (autoScroll && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logEntries, autoScroll]);

  const elapsed = session
    ? (session.finished_at_unix_ms > session.started_at_unix_ms
        ? session.finished_at_unix_ms - session.started_at_unix_ms
        : Date.now() - session.started_at_unix_ms)
    : 0;

  const stepsPerSec = elapsed > 0
    ? ((liveState?.step ?? run?.total_steps ?? 0) / elapsed) * 1000
    : 0;

  const wallTimePerStep = liveState?.wall_time_ns
    ? liveState.wall_time_ns / 1e6
    : 0;
  const hasSolverTelemetry =
    (liveState?.step ?? 0) > 0 ||
    (run?.total_steps ?? 0) > 0 ||
    scalarRows.length > 0 ||
    workspaceStatus === "completed" ||
    workspaceStatus === "failed";
  const solverNotStartedMessage =
    workspaceStatus === "materializing_script"
      ? "Solver not started yet. FEM materialization and tetrahedral meshing are still running."
      : workspaceStatus === "bootstrapping"
        ? "Solver not started yet. Workspace bootstrap is still running."
        : "Solver telemetry is not available yet.";

  // Convergence metric: normalize max_dm_dt to a 0-100 progress bar
  // max_dm_dt < 1e-5 is "converged", > 1e2 is "diverged"
  const dmDtLog = liveState?.max_dm_dt
    ? Math.log10(Math.max(liveState.max_dm_dt, 1e-12))
    : 0;
  const convergencePct = Math.max(0, Math.min(100, ((7 + dmDtLog) / 7) * 100)); // -12→0%, -5→100%
  // Actually: lower dm/dt = more converged, so invert
  const convergenceDisplay = Math.max(0, Math.min(100, 100 - convergencePct));
  const memoryEstimate = Math.min(100, (artifacts.length / 20) * 100);
  const convergenceTone =
    convergenceDisplay > 80 ? "success"
      : convergenceDisplay > 40 ? "warn"
      : "danger";
  const throughputDisplay = Math.min(100, stepsPerSec);
  const throughputTone =
    stepsPerSec > 50 ? "success"
      : stepsPerSec > 10 ? "warn"
      : undefined;
  const statusValueClassName =
    run?.status === "completed"
      ? "text-emerald-500"
      : workspaceStatus === "running"
        ? "text-primary"
        : workspaceStatus === "materializing_script"
          ? "text-amber-500"
          : run?.status === "failed"
            ? "text-destructive"
            : undefined;

  return (
    <div className="flex flex-col h-full bg-background/50 overflow-hidden isolate">
      {/* ─── Header Bar ──────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 bg-card/30 border-b border-border/40">
        <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground mr-auto">Engine Console</span>
        <span className={cn("w-2 h-2 rounded-full shrink-0", (liveState?.finished || run?.status === "completed" ? "completed" : connection) === "completed" ? "bg-emerald-500 shadow-[0_0_6px_var(--status-completed)]" : connection === "connected" ? "bg-primary shadow-[0_0_6px_rgba(99,102,241,0.5)]" : connection === "connecting" ? "bg-amber-500 animate-pulse" : "bg-destructive")} />
        <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">
          {liveState?.finished || run?.status === "completed"
            ? "Completed"
            : connection === "connected"
            ? "Live"
            : connection === "connecting"
            ? "Connecting…"
            : "Offline"}
        </span>
        {session && (
          <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground ml-auto">
            {session.problem_name} · {session.requested_backend.toUpperCase()}
          </span>
        )}
      </div>

      {/* ─── Radix Tabs ─────────────────────────────── */}
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as ConsoleTab)} className="flex flex-col min-h-0 flex-1">
        <TabsList className="flex gap-1 px-2 border-b border-border/40 bg-card/20">
          {TABS.map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value} className="text-xs font-bold uppercase tracking-widest text-muted-foreground hover:text-foreground transition-colors data-[state=active]:text-primary data-[state=active]:border-b-2 data-[state=active]:border-primary pb-2 pt-2.5 px-3 rounded-none bg-transparent shadow-none border-t-0 border-l-0 border-r-0">
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>

      {/* ─── Tab content ─────────────────────────────── */}
      <div className="min-h-[120px] flex-1 flex flex-col focus-visible:outline-none">
        <TabsContent value="live" className="min-h-0 flex-1 flex flex-col focus-visible:outline-none data-[state=inactive]:hidden outline-none">
          <>
            {/* Live telemetry grid */}
            <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-2 p-3">
              <div className="flex flex-col gap-1 p-2.5 rounded-md bg-card/30 border border-border/40 shadow-sm">
                <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Status</span>
                <span className={cn("font-mono text-sm font-semibold text-foreground", statusValueClassName)}>
                  {workspaceStatus}
                </span>
              </div>
              <div className="flex flex-col gap-1 p-2.5 rounded-md bg-card/30 border border-border/40 shadow-sm">
                <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Step</span>
                <span className="font-mono text-sm font-semibold text-foreground">
                  {fmtStepValue(liveState?.step ?? run?.total_steps ?? 0, hasSolverTelemetry)}
                </span>
              </div>
              <div className="flex flex-col gap-1 p-2.5 rounded-md bg-card/30 border border-border/40 shadow-sm">
                <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Sim Time</span>
                <span className="font-mono text-sm font-semibold text-foreground">
                  {fmtTimeOrDash(liveState?.time ?? run?.final_time ?? 0, hasSolverTelemetry)}
                </span>
              </div>
              <div className="flex flex-col gap-1 p-2.5 rounded-md bg-card/30 border border-border/40 shadow-sm">
                <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Δt</span>
                <span className="font-mono text-sm font-semibold text-foreground">
                  {fmtSIOrDash(liveState?.dt ?? 0, "s", hasSolverTelemetry)}
                </span>
              </div>
              <div className="flex flex-col gap-1 p-2.5 rounded-md bg-card/30 border border-border/40 shadow-sm">
                <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">max dm/dt</span>
                <span
                  className={cn("font-mono text-sm font-semibold text-foreground", hasSolverTelemetry && (liveState?.max_dm_dt ?? 0) < 1e-5 && "text-emerald-500")}
                >
                  {fmtExpOrDash(liveState?.max_dm_dt ?? 0, hasSolverTelemetry)}
                </span>
              </div>
              <div className="flex flex-col gap-1 p-2.5 rounded-md bg-card/30 border border-border/40 shadow-sm">
                <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">max |H_eff|</span>
                <span className="font-mono text-sm font-semibold text-foreground">
                  {fmtExpOrDash(liveState?.max_h_eff ?? 0, hasSolverTelemetry)}
                </span>
              </div>
              <div className="flex flex-col gap-1 p-2.5 rounded-md bg-card/30 border border-border/40 shadow-sm">
                <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Elapsed</span>
                <span className="font-mono text-sm font-semibold text-foreground">{fmtDuration(elapsed)}</span>
              </div>
              <div className="flex flex-col gap-1 p-2.5 rounded-md bg-card/30 border border-border/40 shadow-sm">
                <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Throughput</span>
                <span className="font-mono text-sm font-semibold text-foreground">{stepsPerSec > 0 ? `${stepsPerSec.toFixed(1)} st/s` : "—"}</span>
              </div>
            </div>
            {!hasSolverTelemetry && (
              <div className="px-3 pb-3 text-sm text-muted-foreground font-medium">
                {solverNotStartedMessage}
              </div>
            )}

            {/* Convergence bars */}
            <div className="px-3 py-2 flex flex-col gap-2">
              <div className="grid grid-cols-[100px_1fr_70px] gap-2 items-center py-1">
                <span className="text-xs font-semibold text-muted-foreground">Convergence</span>
                <progress
                  className="w-full h-1.5 rounded-full overflow-hidden bg-muted appearance-none fill-primary [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:bg-primary [&::-moz-progress-bar]:bg-primary data-[tone=success]:[&::-webkit-progress-value]:bg-emerald-500 data-[tone=warn]:[&::-webkit-progress-value]:bg-amber-500 data-[tone=danger]:[&::-webkit-progress-value]:bg-destructive"
                  value={convergenceDisplay}
                  max={100}
                  data-tone={convergenceTone}
                />
                <span className="font-mono text-[0.7rem] font-semibold text-muted-foreground text-right">
                  {convergenceDisplay.toFixed(0)}%
                </span>
              </div>
              <div className="grid grid-cols-[100px_1fr_70px] gap-2 items-center py-1">
                <span className="text-xs font-semibold text-muted-foreground">Memory est.</span>
                <progress className="w-full h-1.5 rounded-full overflow-hidden bg-muted appearance-none fill-primary [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:bg-primary [&::-moz-progress-bar]:bg-primary data-[tone=success]:[&::-webkit-progress-value]:bg-emerald-500 data-[tone=warn]:[&::-webkit-progress-value]:bg-amber-500 data-[tone=danger]:[&::-webkit-progress-value]:bg-destructive" value={memoryEstimate} max={100} />
                <span className="font-mono text-[0.7rem] font-semibold text-muted-foreground text-right">
                  {artifacts.length} files
                </span>
              </div>
            </div>
          </>
        </TabsContent>

        <TabsContent value="log" className="min-h-0 flex-1 flex flex-col focus-visible:outline-none data-[state=inactive]:hidden outline-none">
          <div
            className="max-h-[360px] overflow-y-auto py-2 pr-1 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-muted-foreground/20"
            ref={logContainerRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
              setAutoScroll(atBottom);
            }}
          >
            {logEntries.length === 0 ? (
              <div className="p-4 text-sm text-muted-foreground text-center font-medium">
                Waiting for events…
              </div>
            ) : (
              logEntries.map((entry, i) => (
                <div key={i} className="grid grid-cols-[52px_16px_1fr] gap-1.5 px-3 py-1 items-baseline font-mono text-xs hover:bg-muted/30 transition-colors">
                  <span className="text-[0.65rem] text-muted-foreground/70 text-right pr-1">
                    {session
                      ? `+${((entry.time - session.started_at_unix_ms) / 1000).toFixed(1)}s`
                      : "—"}
                  </span>
                  <span className="text-center flex justify-center items-center text-muted-foreground/70">{entry.icon}</span>
                  <span className="text-foreground break-all data-[severity=info]:text-muted-foreground data-[severity=success]:text-emerald-500 data-[severity=warn]:text-amber-500 data-[severity=error]:text-destructive data-[severity=system]:text-primary" data-severity={entry.severity}>
                    {entry.message}
                  </span>
                </div>
              ))
            )}
          </div>
        </TabsContent>

        <TabsContent value="energy" className="min-h-0 flex-1 flex flex-col focus-visible:outline-none data-[state=inactive]:hidden outline-none">
          <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2 p-3">
            <div className="flex flex-col gap-1 p-2.5 rounded-md bg-card/30 border border-border/40 shadow-sm border-l-[3px] border-l-sky-500">
              <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">E_exchange</span>
              <span className="font-mono text-sm font-semibold text-foreground">
                {fmtSI(liveState?.e_ex ?? run?.final_e_ex ?? 0, "J")}
              </span>
            </div>
            <div className="flex flex-col gap-1 p-2.5 rounded-md bg-card/30 border border-border/40 shadow-sm border-l-[3px] border-l-amber-500">
              <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">E_demag</span>
              <span className="font-mono text-sm font-semibold text-foreground">
                {fmtSI(liveState?.e_demag ?? run?.final_e_demag ?? 0, "J")}
              </span>
            </div>
            <div className="flex flex-col gap-1 p-2.5 rounded-md bg-card/30 border border-border/40 shadow-sm border-l-[3px] border-l-emerald-500">
              <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">E_ext</span>
              <span className="font-mono text-sm font-semibold text-foreground">
                {fmtSI(liveState?.e_ext ?? run?.final_e_ext ?? 0, "J")}
              </span>
            </div>
            <div className="flex flex-col gap-1 p-2.5 rounded-md bg-card/30 border border-border/40 shadow-sm border-l-[3px] border-l-indigo-500">
              <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">E_total</span>
              <span className="font-mono text-sm font-semibold text-foreground">
                {fmtSI(liveState?.e_total ?? run?.final_e_total ?? 0, "J")}
              </span>
            </div>

            {/* Energy deltas from scalar history */}
            {scalarRows.length >= 2 && (() => {
              const last = scalarRows[scalarRows.length - 1];
              const prev = scalarRows[scalarRows.length - 2];
              const dE = last.e_total - prev.e_total;
              const dStep = last.step - prev.step;
              return (
                <>
                  <div className="flex flex-col gap-1 p-2.5 rounded-md bg-card/30 border border-border/40 shadow-sm border-l-[3px] border-l-muted-foreground">
                    <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">ΔE_total / step</span>
                    <span className={cn("font-mono text-sm font-semibold text-foreground", dE < 0 ? "text-emerald-500" : "text-destructive")}>
                      {dStep > 0 ? fmtExp(dE / dStep) : "—"}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1 p-2.5 rounded-md bg-card/30 border border-border/40 shadow-sm border-l-[3px] border-l-muted-foreground">
                    <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">History points</span>
                    <span className="font-mono text-sm font-semibold text-foreground">{scalarRows.length}</span>
                  </div>
                </>
              );
            })()}
          </div>
        </TabsContent>

        <TabsContent value="charts" className="min-h-0 flex-1 flex flex-col focus-visible:outline-none data-[state=inactive]:hidden outline-none">
          <div className="flex flex-col h-full bg-card/10">
            <div className="flex gap-1 px-3 py-2 shrink-0 border-b border-border/40 bg-card/20 overflow-x-auto scrollbar-none">
              {(Object.keys(CHART_PRESETS) as ChartPreset[]).map((key) => (
                <button
                  key={key}
                  className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground px-2.5 py-1.5 rounded-md border border-border/40 bg-muted/30 hover:bg-muted/60 transition-colors data-[active=true]:bg-primary/20 data-[active=true]:text-primary data-[active=true]:border-primary/50 whitespace-nowrap"
                  data-active={chartPreset === key}
                  onClick={() => setChartPreset(key)}
                >
                  {CHART_PRESETS[key].label}
                </button>
              ))}
            </div>
            {scalarRows.length < 2 ? (
              <div className="p-6 text-sm text-muted-foreground text-center flex-1 flex items-center justify-center font-medium">
                Waiting for at least 2 data points to render chart…
              </div>
            ) : (
              <div className="flex-1 min-h-[180px] relative p-2">
                <div className="absolute inset-0 p-2">
                  <ScalarPlot
                    rows={scalarRows}
                    xColumn="time"
                    yColumns={CHART_PRESETS[chartPreset].yColumns}
                  />
                </div>
              </div>
            )}
          </div>
        </TabsContent>

        <TabsContent value="table" className="min-h-0 flex-1 flex flex-col focus-visible:outline-none data-[state=inactive]:hidden outline-none">
          <ScalarTable rows={scalarRows} />
        </TabsContent>

        <TabsContent value="progress" className="min-h-0 flex-1 flex flex-col focus-visible:outline-none data-[state=inactive]:hidden outline-none">
          <div className="p-3 flex flex-col gap-3">
            {/* Phase timeline */}
            {[
              { label: "Bootstrap", done: !!session, active: workspaceStatus === "bootstrapping" },
              { label: "Materialize", done: workspaceStatus !== "materializing_script" && workspaceStatus !== "bootstrapping" && !!session, active: workspaceStatus === "materializing_script" },
              { label: "Solving", done: workspaceStatus === "completed" || (hasSolverTelemetry && (liveState?.max_dm_dt ?? 1) < 1e-5), active: workspaceStatus === "running" || workspaceStatus === "awaiting_command" },
              { label: "Converged", done: hasSolverTelemetry && (liveState?.max_dm_dt ?? 1) < 1e-5, active: false },
            ].map((phase) => (
              <div key={phase.label} className="grid grid-cols-[100px_1fr_70px] gap-2 items-center py-1">
                <span
                  className={cn("text-xs font-semibold text-muted-foreground", phase.done && "text-emerald-500", !phase.done && phase.active && "text-primary")}
                >
                  {phase.done ? "✓" : phase.active ? "●" : "○"} {phase.label}
                </span>
                <progress
                  className="w-full h-1.5 rounded-full overflow-hidden bg-muted appearance-none fill-primary [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:bg-primary [&::-moz-progress-bar]:bg-primary data-[tone=success]:[&::-webkit-progress-value]:bg-emerald-500 data-[tone=warn]:[&::-webkit-progress-value]:bg-amber-500 data-[tone=danger]:[&::-webkit-progress-value]:bg-destructive"
                  value={phase.done ? 100 : phase.active ? 50 : 0}
                  max={100}
                  data-tone={phase.done ? "success" : undefined}
                />
              </div>
            ))}

            {/* Convergence metric */}
            <div className="grid grid-cols-[100px_1fr_70px] gap-2 items-center py-1 mt-2">
              <span className="text-xs font-semibold text-muted-foreground">Convergence</span>
              <progress
                className="w-full h-1.5 rounded-full overflow-hidden bg-muted appearance-none fill-primary [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:bg-primary [&::-moz-progress-bar]:bg-primary data-[tone=success]:[&::-webkit-progress-value]:bg-emerald-500 data-[tone=warn]:[&::-webkit-progress-value]:bg-amber-500 data-[tone=danger]:[&::-webkit-progress-value]:bg-destructive"
                value={convergenceDisplay}
                max={100}
                data-tone={convergenceTone}
              />
              <span className="font-mono text-[0.7rem] font-semibold text-muted-foreground text-right">{convergenceDisplay.toFixed(0)}%</span>
            </div>

            {/* Key metrics */}
            <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-2 p-0 mt-2">
              <div className="flex flex-col gap-1 p-2.5 rounded-md bg-card/30 border border-border/40 shadow-sm">
                <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Steps</span>
                <span className="font-mono text-sm font-semibold text-foreground">{(liveState?.step ?? run?.total_steps ?? 0).toLocaleString()}</span>
              </div>
              <div className="flex flex-col gap-1 p-2.5 rounded-md bg-card/30 border border-border/40 shadow-sm">
                <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Sim Time</span>
                <span className="font-mono text-sm font-semibold text-foreground">{fmtTimeOrDash(liveState?.time ?? 0, hasSolverTelemetry)}</span>
              </div>
              <div className="flex flex-col gap-1 p-2.5 rounded-md bg-card/30 border border-border/40 shadow-sm">
                <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Elapsed</span>
                <span className="font-mono text-sm font-semibold text-foreground">{fmtDuration(elapsed)}</span>
              </div>
              <div className="flex flex-col gap-1 p-2.5 rounded-md bg-card/30 border border-border/40 shadow-sm">
                <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">max dm/dt</span>
                <span
                  className={cn("font-mono text-sm font-semibold text-foreground", hasSolverTelemetry && (liveState?.max_dm_dt ?? 1) < 1e-5 && "text-emerald-500")}
                >
                  {fmtExpOrDash(liveState?.max_dm_dt ?? 0, hasSolverTelemetry)}
                </span>
              </div>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="perf" className="min-h-0 flex-1 flex flex-col focus-visible:outline-none data-[state=inactive]:hidden outline-none">
          <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2 p-3">
            <div className="flex flex-col gap-1 p-2.5 rounded-md bg-card/30 border border-border/40 shadow-sm">
              <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Backend</span>
              <span className="font-mono text-sm font-semibold text-foreground">{session?.requested_backend?.toUpperCase() ?? "—"}</span>
            </div>
            <div className="flex flex-col gap-1 p-2.5 rounded-md bg-card/30 border border-border/40 shadow-sm">
              <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Mode</span>
              <span className="font-mono text-sm font-semibold text-foreground">{session?.execution_mode ?? "—"}</span>
            </div>
            <div className="flex flex-col gap-1 p-2.5 rounded-md bg-card/30 border border-border/40 shadow-sm">
              <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Precision</span>
              <span className="font-mono text-sm font-semibold text-foreground">{session?.precision ?? "—"}</span>
            </div>
            <div className="flex flex-col gap-1 p-2.5 rounded-md bg-card/30 border border-border/40 shadow-sm">
              <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Total Steps</span>
              <span className="font-mono text-sm font-semibold text-foreground">{(liveState?.step ?? run?.total_steps ?? 0).toLocaleString()}</span>
            </div>
            <div className="flex flex-col gap-1 p-2.5 rounded-md bg-card/30 border border-border/40 shadow-sm">
              <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Throughput</span>
              <span className="font-mono text-sm font-semibold text-foreground">{stepsPerSec > 0 ? `${stepsPerSec.toFixed(1)} st/s` : "—"}</span>
            </div>
            <div className="flex flex-col gap-1 p-2.5 rounded-md bg-card/30 border border-border/40 shadow-sm">
              <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Wall/step</span>
              <span className="font-mono text-sm font-semibold text-foreground">{wallTimePerStep > 0 ? `${wallTimePerStep.toFixed(2)} ms` : "—"}</span>
            </div>
            <div className="flex flex-col gap-1 p-2.5 rounded-md bg-card/30 border border-border/40 shadow-sm">
              <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Elapsed</span>
              <span className="font-mono text-sm font-semibold text-foreground">{fmtDuration(elapsed)}</span>
            </div>
            <div className="flex flex-col gap-1 p-2.5 rounded-md bg-card/30 border border-border/40 shadow-sm">
              <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Artifacts</span>
              <span className="font-mono text-sm font-semibold text-foreground">{artifacts.length}</span>
            </div>

            {/* Throughput bar */}
            <div className="flex flex-col gap-1 p-2.5 rounded-md bg-card/30 border border-border/40 shadow-sm col-span-full">
              <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Throughput (steps/sec)</span>
              <progress
                className="w-full h-1.5 rounded-full overflow-hidden bg-muted appearance-none fill-primary [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:bg-primary [&::-moz-progress-bar]:bg-primary data-[tone=success]:[&::-webkit-progress-value]:bg-emerald-500 data-[tone=warn]:[&::-webkit-progress-value]:bg-amber-500 data-[tone=danger]:[&::-webkit-progress-value]:bg-destructive"
                value={throughputDisplay}
                max={100}
                data-tone={throughputTone}
              />
              <span className="font-mono text-[0.7rem] font-semibold text-foreground mt-1">
                {stepsPerSec > 0 ? `${stepsPerSec.toFixed(2)} steps/sec` : "Waiting for data…"}
              </span>
            </div>
          </div>
        </TabsContent>
      </div>
      </Tabs>
    </div>
  );
}
