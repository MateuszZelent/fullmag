"use client";

import { useRef, useEffect, useState, useMemo } from "react";
import type { LiveState, ScalarRow, SessionManifest, RunManifest, ArtifactEntry, EngineLogEntry, CommandStatus, MeshWorkspaceState } from "../../lib/useSessionStream";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { fmtSI, fmtExp, fmtTime, fmtDuration, fmtStepValue, fmtSIOrDash, fmtExpOrDash } from "@/lib/format";
import ScalarPlot from "../plots/ScalarPlot";
import ScalarTable from "./ScalarTable";
import { buildLogEntries } from "./engine/buildLogEntries";
import { CHART_PRESETS } from "./engine/chartPresets";
import { DEFAULT_CONVERGENCE_THRESHOLD } from "./SolverSettingsPanel";
import type { ActivityInfo } from "../runs/control-room/types";

/* ── Types ─────────────────────────────────────────────────── */

type ConsoleTab = "live" | "log" | "energy" | "charts" | "table" | "progress" | "perf";
export type ChartPreset = "energy" | "magnetization" | "convergence" | "timestep" | "all";
export interface ChartPresetConfig { label: string; yColumns: string[] }

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
  convergenceThreshold?: number;
  commandStatus?: CommandStatus | null;
  commandBusy?: boolean;
  commandMessage?: string | null;
  activity?: ActivityInfo | null;
  meshWorkspace?: MeshWorkspaceState | null;
}

function fmtTimeOrDash(v: number, enabled: boolean): string {
  return enabled ? fmtTime(v) : "—";
}

function estimateMeshPayloadBytes(
  nodeCount: number,
  elementCount: number,
  boundaryFaceCount: number,
): number {
  return (
    nodeCount * 3 * 8 +
    elementCount * 4 * 4 +
    elementCount * 4 +
    boundaryFaceCount * 3 * 4 +
    boundaryFaceCount * 4
  );
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${Math.round(bytes)} B`;
}

/* buildLogEntries and CHART_PRESETS extracted to engine/ submodules */

/* ── Component ─────────────────────────────────────────────── */

const TABS: { value: ConsoleTab; label: string }[] = [
  { value: "progress", label: "Progress" },
  { value: "live", label: "Live" },
  { value: "log", label: "Log" },
  { value: "charts", label: "Charts" },
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
  convergenceThreshold: convergenceThresholdProp,
  commandStatus = null,
  commandBusy = false,
  commandMessage = null,
  activity = null,
  meshWorkspace = null,
}: EngineConsoleProps) {
  const convergenceThreshold = convergenceThresholdProp ?? DEFAULT_CONVERGENCE_THRESHOLD;
  const [activeTab, setActiveTab] = useState<ConsoleTab>("progress");
  const [chartPreset, setChartPreset] = useState<ChartPreset>("energy");
  /* Note: we keep state manually for backwards compat; Radix Tabs controlled via value/onValueChange */
  const logContainerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  const logEntries = useMemo(
    () => buildLogEntries(session, run, liveState, scalarRows, engineLog, connection, error, presentationMode, convergenceThreshold),
    [session, run, liveState, scalarRows, engineLog, connection, error, presentationMode, convergenceThreshold],
  );
  const meshSummary = meshWorkspace?.mesh_summary ?? null;
  const meshQualitySummary = meshWorkspace?.mesh_quality_summary ?? null;
  const meshPayloadEstimate = formatBytes(
    estimateMeshPayloadBytes(
      meshSummary?.node_count ?? 0,
      meshSummary?.element_count ?? 0,
      meshSummary?.boundary_face_count ?? 0,
    ),
  );
  const activeCommandLabel = commandStatus?.command_kind
    ? commandStatus.command_kind.toUpperCase()
    : (commandBusy ? "PENDING" : "—");
  const activeCommandStateLabel = commandStatus
    ? (commandStatus.state === "completed"
      ? `COMPLETED${commandStatus.completion_state ? ` (${commandStatus.completion_state})` : ""}`
      : commandStatus.state.toUpperCase())
    : (commandBusy ? "POSTING" : "IDLE");
  const activityLabel = activity?.label ?? "Idle";
  const activityDetail = activity?.detail ?? commandMessage ?? "No active runtime command.";
  const meshProgressValue = activity?.progressMode === "determinate"
    ? activity.progressValue ?? 0
    : (commandBusy ? 42 : 100);

  const workspaceStatus = liveState?.status ?? session?.status ?? run?.status ?? "idle";

  useEffect(() => {
    if (autoScroll && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logEntries, autoScroll]);

  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (workspaceStatus !== "running" && workspaceStatus !== "materializing_script") {
      return;
    }
    const interval = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(interval);
  }, [workspaceStatus]);

  const elapsed = useMemo(() => {
    if (!session) return 0;
    if (session.finished_at_unix_ms > session.started_at_unix_ms) {
      return session.finished_at_unix_ms - session.started_at_unix_ms;
    }
    return now - session.started_at_unix_ms;
  }, [session, now]);

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
  // max_dm_dt < convergenceThreshold is "converged", > 1e2 is "diverged"
  const LOG_DECADES = 7;          // display spans 7 decades (from LOG_FLOOR to LOG_FLOOR + 7)
  const dmDtLog = liveState?.max_dm_dt
    ? Math.log10(Math.max(liveState.max_dm_dt, 1e-12))
    : 0;
  const convergencePct = Math.max(0, Math.min(100, ((LOG_DECADES + dmDtLog) / LOG_DECADES) * 100));
  // Lower dm/dt = more converged, so invert
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
    <div className="flex flex-col h-full bg-background/35 overflow-hidden isolate">
      {/* ─── Header Bar ──────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 bg-background/45 border-b border-white/5">
        <span className="text-[0.68rem] font-semibold tracking-wide text-muted-foreground mr-auto">Messages & Progress</span>
        <span className={cn("w-2 h-2 rounded-full shrink-0", (liveState?.finished || run?.status === "completed" ? "completed" : connection) === "completed" ? "bg-emerald-500 shadow-[0_0_6px_var(--status-completed)]" : connection === "connected" ? "bg-primary shadow-[0_0_6px_rgba(99,102,241,0.5)]" : connection === "connecting" ? "bg-amber-500 animate-pulse" : "bg-destructive")} />
        <span className="text-[0.65rem] font-medium tracking-wide text-muted-foreground">
          {liveState?.finished || run?.status === "completed"
            ? "Completed"
            : connection === "connected"
            ? "Live"
            : connection === "connecting"
            ? "Connecting…"
            : "Offline"}
        </span>
        {session && (
          <span className="text-[0.64rem] font-medium tracking-wide text-muted-foreground ml-auto">
            {session.problem_name} · {session.requested_backend.toUpperCase()}
          </span>
        )}
      </div>

      {/* ─── Radix Tabs ─────────────────────────────── */}
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as ConsoleTab)} className="flex flex-col min-h-0 flex-1">
        <TabsList className="flex h-auto gap-1 px-2 py-1 border-b border-white/5 bg-background/30 rounded-none border-x-0 border-t-0">
          {TABS.map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value} className="min-h-[32px] rounded-md px-3 py-1 text-[0.7rem] font-medium normal-case tracking-normal text-muted-foreground data-[state=active]:bg-primary/10 data-[state=active]:text-primary data-[state=active]:border-transparent">
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
              <div className="flex flex-col gap-1 p-2.5 rounded-md bg-card/20 shadow-sm border-l-[3px] border-l-primary">
                <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground">Status</span>
                <span className={cn("font-mono text-sm font-semibold text-foreground", statusValueClassName)}>
                  {workspaceStatus}
                </span>
              </div>
              <div className="flex flex-col gap-1 p-2.5 rounded-md bg-card/20 shadow-sm border-l-[3px] border-l-sky-500">
                <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground">Step</span>
                <span className="font-mono text-sm font-semibold text-foreground">
                  {fmtStepValue(liveState?.step ?? run?.total_steps ?? 0, hasSolverTelemetry)}
                </span>
              </div>
              <div className="flex flex-col gap-1 p-2.5 rounded-md bg-card/20 shadow-sm border-l-[3px] border-l-violet-500">
                <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground">Sim Time</span>
                <span className="font-mono text-sm font-semibold text-foreground">
                  {fmtTimeOrDash(liveState?.time ?? run?.final_time ?? 0, hasSolverTelemetry)}
                </span>
              </div>
              <div className="flex flex-col gap-1 p-2.5 rounded-md bg-card/20 shadow-sm border-l-[3px] border-l-amber-500">
                <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground">Δt</span>
                <span className="font-mono text-sm font-semibold text-foreground">
                  {fmtSIOrDash(liveState?.dt ?? 0, "s", hasSolverTelemetry)}
                </span>
              </div>
              <div className="flex flex-col gap-1 p-2.5 rounded-md bg-card/20 shadow-sm border-l-[3px] border-l-emerald-500">
                <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground">max dm/dt</span>
                <span
                  className={cn("font-mono text-sm font-semibold text-foreground", hasSolverTelemetry && (liveState?.max_dm_dt ?? 0) < convergenceThreshold && "text-emerald-500")}
                >
                  {fmtExpOrDash(liveState?.max_dm_dt ?? 0, hasSolverTelemetry)}
                </span>
              </div>
              <div className="flex flex-col gap-1 p-2.5 rounded-md bg-card/20 shadow-sm border-l-[3px] border-l-rose-500">
                <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground">max |H_eff|</span>
                <span className="font-mono text-sm font-semibold text-foreground">
                  {fmtExpOrDash(liveState?.max_h_eff ?? 0, hasSolverTelemetry)}
                </span>
              </div>
              <div className="flex flex-col gap-1 p-2.5 rounded-md bg-card/20 shadow-sm border-l-[3px] border-l-slate-400">
                <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground">Elapsed</span>
                <span className="font-mono text-sm font-semibold text-foreground">{fmtDuration(elapsed)}</span>
              </div>
              <div className="flex flex-col gap-1 p-2.5 rounded-md bg-card/20 shadow-sm border-l-[3px] border-l-orange-500">
                <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground">Throughput</span>
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
            <div className="flex flex-col gap-1 p-2.5 rounded-md bg-card/20 shadow-sm border-l-[3px] border-l-sky-500">
              <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground">E_exchange</span>
              <span className="font-mono text-sm font-semibold text-foreground">
                {fmtSI(liveState?.e_ex ?? run?.final_e_ex ?? 0, "J")}
              </span>
            </div>
            <div className="flex flex-col gap-1 p-2.5 rounded-md bg-card/20 shadow-sm border-l-[3px] border-l-amber-500">
              <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground">E_demag</span>
              <span className="font-mono text-sm font-semibold text-foreground">
                {fmtSI(liveState?.e_demag ?? run?.final_e_demag ?? 0, "J")}
              </span>
            </div>
            <div className="flex flex-col gap-1 p-2.5 rounded-md bg-card/20 shadow-sm border-l-[3px] border-l-emerald-500">
              <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground">E_ext</span>
              <span className="font-mono text-sm font-semibold text-foreground">
                {fmtSI(liveState?.e_ext ?? run?.final_e_ext ?? 0, "J")}
              </span>
            </div>
            <div className="flex flex-col gap-1 p-2.5 rounded-md bg-card/20 shadow-sm border-l-[3px] border-l-rose-500">
              <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground">E_ani</span>
              <span className="font-mono text-sm font-semibold text-foreground">
                {fmtSI(liveState?.e_ani ?? run?.final_e_ani ?? 0, "J")}
              </span>
            </div>
            <div className="flex flex-col gap-1 p-2.5 rounded-md bg-card/20 shadow-sm border-l-[3px] border-l-fuchsia-500">
              <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground">E_dmi</span>
              <span className="font-mono text-sm font-semibold text-foreground">
                {fmtSI(liveState?.e_dmi ?? run?.final_e_dmi ?? 0, "J")}
              </span>
            </div>
            <div className="flex flex-col gap-1 p-2.5 rounded-md bg-card/20 shadow-sm border-l-[3px] border-l-indigo-500">
              <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground">E_total</span>
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
                  <div className="flex flex-col gap-1 p-2.5 rounded-md bg-card/20 shadow-sm border-l-[3px] border-l-muted-foreground">
                    <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground">ΔE_total / step</span>
                    <span className={cn("font-mono text-sm font-semibold text-foreground", dE < 0 ? "text-emerald-500" : "text-destructive")}>
                      {dStep > 0 ? fmtExp(dE / dStep) : "—"}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1 p-2.5 rounded-md bg-card/20 shadow-sm border-l-[3px] border-l-muted-foreground">
                    <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground">History points</span>
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
                  className="text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground px-2.5 py-1.5 rounded-md border border-border/40 bg-muted/30 hover:bg-muted/60 transition-colors data-[active=true]:bg-primary/20 data-[active=true]:text-primary data-[active=true]:border-primary/50 whitespace-nowrap"
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
              { label: "Solving", done: workspaceStatus === "completed" || (hasSolverTelemetry && (liveState?.max_dm_dt ?? 1) < convergenceThreshold), active: workspaceStatus === "running" || workspaceStatus === "awaiting_command" },
              { label: "Converged", done: hasSolverTelemetry && (liveState?.max_dm_dt ?? 1) < convergenceThreshold, active: false },
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
                <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground">Command</span>
                <span className="font-mono text-sm font-semibold text-foreground">{activeCommandLabel}</span>
              </div>
              <div className="flex flex-col gap-1 p-2.5 rounded-md bg-card/30 border border-border/40 shadow-sm">
                <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground">Command State</span>
                <span className="font-mono text-sm font-semibold text-foreground">{activeCommandStateLabel}</span>
              </div>
              <div className="flex flex-col gap-1 p-2.5 rounded-md bg-card/30 border border-border/40 shadow-sm">
                <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground">Steps</span>
                <span className="font-mono text-sm font-semibold text-foreground">{(liveState?.step ?? run?.total_steps ?? 0).toLocaleString()}</span>
              </div>
              <div className="flex flex-col gap-1 p-2.5 rounded-md bg-card/30 border border-border/40 shadow-sm">
                <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground">Sim Time</span>
                <span className="font-mono text-sm font-semibold text-foreground">{fmtTimeOrDash(liveState?.time ?? 0, hasSolverTelemetry)}</span>
              </div>
              <div className="flex flex-col gap-1 p-2.5 rounded-md bg-card/30 border border-border/40 shadow-sm">
                <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground">Elapsed</span>
                <span className="font-mono text-sm font-semibold text-foreground">{fmtDuration(elapsed)}</span>
              </div>
              <div className="flex flex-col gap-1 p-2.5 rounded-md bg-card/30 border border-border/40 shadow-sm">
                <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground">max dm/dt</span>
                <span
                  className={cn("font-mono text-sm font-semibold text-foreground", hasSolverTelemetry && (liveState?.max_dm_dt ?? 1) < convergenceThreshold && "text-emerald-500")}
                >
                  {fmtExpOrDash(liveState?.max_dm_dt ?? 0, hasSolverTelemetry)}
                </span>
              </div>
              <div className="flex flex-col gap-1 p-2.5 rounded-md bg-card/30 border border-border/40 shadow-sm">
                <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground">Mesh Nodes</span>
                <span className="font-mono text-sm font-semibold text-foreground">{meshSummary?.node_count.toLocaleString() ?? "—"}</span>
              </div>
              <div className="flex flex-col gap-1 p-2.5 rounded-md bg-card/30 border border-border/40 shadow-sm">
                <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground">Tetrahedra</span>
                <span className="font-mono text-sm font-semibold text-foreground">{meshSummary?.element_count.toLocaleString() ?? "—"}</span>
              </div>
            </div>
            <div className="grid gap-2 rounded-md border border-border/40 bg-card/20 p-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {activityLabel}
                </span>
                <span className="font-mono text-[0.7rem] font-semibold text-muted-foreground">
                  {activity?.progressMode === "determinate"
                    ? `${Math.round(meshProgressValue)}%`
                    : (commandBusy ? "ACTIVE" : "READY")}
                </span>
              </div>
              <progress
                className="w-full h-1.5 rounded-full overflow-hidden bg-muted appearance-none fill-primary [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:bg-primary [&::-moz-progress-bar]:bg-primary"
                value={Math.max(0, Math.min(100, meshProgressValue))}
                max={100}
              />
              <div className="text-xs text-muted-foreground">{activityDetail}</div>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="perf" className="min-h-0 flex-1 flex flex-col focus-visible:outline-none data-[state=inactive]:hidden outline-none">
          <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2 p-3">
            <div className="flex flex-col gap-1 p-2.5 rounded-md bg-card/30 border border-border/40 shadow-sm">
              <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground">Backend</span>
              <span className="font-mono text-sm font-semibold text-foreground">{session?.requested_backend?.toUpperCase() ?? "—"}</span>
            </div>
            <div className="flex flex-col gap-1 p-2.5 rounded-md bg-card/30 border border-border/40 shadow-sm">
              <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground">Mode</span>
              <span className="font-mono text-sm font-semibold text-foreground">{session?.execution_mode ?? "—"}</span>
            </div>
            <div className="flex flex-col gap-1 p-2.5 rounded-md bg-card/30 border border-border/40 shadow-sm">
              <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground">Precision</span>
              <span className="font-mono text-sm font-semibold text-foreground">{session?.precision ?? "—"}</span>
            </div>
            <div className="flex flex-col gap-1 p-2.5 rounded-md bg-card/30 border border-border/40 shadow-sm">
              <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground">Total Steps</span>
              <span className="font-mono text-sm font-semibold text-foreground">{(liveState?.step ?? run?.total_steps ?? 0).toLocaleString()}</span>
            </div>
            <div className="flex flex-col gap-1 p-2.5 rounded-md bg-card/30 border border-border/40 shadow-sm">
              <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground">Throughput</span>
              <span className="font-mono text-sm font-semibold text-foreground">{stepsPerSec > 0 ? `${stepsPerSec.toFixed(1)} st/s` : "—"}</span>
            </div>
            <div className="flex flex-col gap-1 p-2.5 rounded-md bg-card/30 border border-border/40 shadow-sm">
              <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground">Wall/step</span>
              <span className="font-mono text-sm font-semibold text-foreground">{wallTimePerStep > 0 ? `${wallTimePerStep.toFixed(2)} ms` : "—"}</span>
            </div>
            <div className="flex flex-col gap-1 p-2.5 rounded-md bg-card/30 border border-border/40 shadow-sm">
              <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground">Elapsed</span>
              <span className="font-mono text-sm font-semibold text-foreground">{fmtDuration(elapsed)}</span>
            </div>
            <div className="flex flex-col gap-1 p-2.5 rounded-md bg-card/30 border border-border/40 shadow-sm">
              <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground">Artifacts</span>
              <span className="font-mono text-sm font-semibold text-foreground">{artifacts.length}</span>
            </div>
            <div className="flex flex-col gap-1 p-2.5 rounded-md bg-card/30 border border-border/40 shadow-sm">
              <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground">Mesh Nodes</span>
              <span className="font-mono text-sm font-semibold text-foreground">{meshSummary?.node_count.toLocaleString() ?? "—"}</span>
            </div>
            <div className="flex flex-col gap-1 p-2.5 rounded-md bg-card/30 border border-border/40 shadow-sm">
              <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground">Tetrahedra</span>
              <span className="font-mono text-sm font-semibold text-foreground">{meshSummary?.element_count.toLocaleString() ?? "—"}</span>
            </div>
            <div className="flex flex-col gap-1 p-2.5 rounded-md bg-card/30 border border-border/40 shadow-sm">
              <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground">Boundary Faces</span>
              <span className="font-mono text-sm font-semibold text-foreground">{meshSummary?.boundary_face_count.toLocaleString() ?? "—"}</span>
            </div>
            <div className="flex flex-col gap-1 p-2.5 rounded-md bg-card/30 border border-border/40 shadow-sm">
              <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground">Mesh Payload Est.</span>
              <span className="font-mono text-sm font-semibold text-foreground">{meshPayloadEstimate}</span>
            </div>
            <div className="flex flex-col gap-1 p-2.5 rounded-md bg-card/30 border border-border/40 shadow-sm">
              <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground">Avg Quality</span>
              <span className="font-mono text-sm font-semibold text-foreground">
                {meshQualitySummary ? meshQualitySummary.avg_quality.toFixed(3) : "—"}
              </span>
            </div>
            <div className="flex flex-col gap-1 p-2.5 rounded-md bg-card/30 border border-border/40 shadow-sm">
              <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground">Command State</span>
              <span className="font-mono text-sm font-semibold text-foreground">{activeCommandStateLabel}</span>
            </div>

            {/* Throughput bar */}
            <div className="flex flex-col gap-1 p-2.5 rounded-md bg-card/30 border border-border/40 shadow-sm col-span-full">
              <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground">Throughput (steps/sec)</span>
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
