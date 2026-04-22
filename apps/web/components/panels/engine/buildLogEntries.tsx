import {
  Play, Settings, Loader2, Pause, Circle, Diamond,
  ArrowRight, CheckCircle2, XCircle, AlertTriangle, Dot,
} from "lucide-react";
import type { LiveState, ScalarRow, SessionManifest, RunManifest, EngineLogEntry } from "@/lib/session/types";
import { fmtTime, fmtExp, fmtDuration } from "@/lib/format";

export interface LogEntry {
  time: number;
  icon: React.ReactNode;
  message: string;
  severity: "info" | "success" | "warn" | "error" | "system";
}

export function buildLogEntries(
  session: SessionManifest | null,
  run: RunManifest | null,
  liveState: LiveState | null,
  scalarRows: ScalarRow[],
  engineLog: EngineLogEntry[],
  connection: string,
  error: string | null,
  presentationMode: "session" | "current",
  convergenceThreshold: number,
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
            : `Workspace started — ${session.problem_name}`,
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

  // Convergence check
  if (liveState && convergenceThreshold > 0 && liveState.max_dm_dt < convergenceThreshold && liveState.step > 10) {
    entries.push({
      time: liveState.updated_at_unix_ms || now,
      icon: <CheckCircle2 size={12} />,
      message: `Convergence criterion: max_dm/dt = ${fmtExp(liveState.max_dm_dt)} < ${convergenceThreshold.toExponential(1)} — approaching equilibrium`,
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
