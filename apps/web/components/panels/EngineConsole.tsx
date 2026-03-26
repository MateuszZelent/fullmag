"use client";

import { useRef, useEffect, useState, useMemo, useCallback } from "react";
import type { LiveState, ScalarRow, SessionManifest, RunManifest, ArtifactEntry } from "../../lib/useSessionStream";
import s from "./EngineConsole.module.css";

/* ── Types ─────────────────────────────────────────────────── */

type ConsoleTab = "live" | "log" | "energy" | "perf";

interface EngineConsoleProps {
  session: SessionManifest | null;
  run: RunManifest | null;
  liveState: LiveState | null;
  scalarRows: ScalarRow[];
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

function fmtRate(steps: number, ms: number): string {
  if (ms <= 0) return "—";
  const rate = (steps / ms) * 1000;
  if (rate >= 1) return `${rate.toFixed(1)} steps/s`;
  return `${(1000 / rate).toFixed(0)} ms/step`;
}

/* ── Log entry type ────────────────────────────────────────── */

interface LogEntry {
  time: number;
  icon: string;
  message: string;
  severity: "info" | "success" | "warn" | "error" | "system";
}

function buildLogEntries(
  session: SessionManifest | null,
  run: RunManifest | null,
  liveState: LiveState | null,
  scalarRows: ScalarRow[],
  connection: string,
  error: string | null,
  presentationMode: "session" | "current",
): LogEntry[] {
  const entries: LogEntry[] = [];
  const now = Date.now();

  if (session) {
    entries.push({
      time: session.started_at_unix_ms,
      icon: "▶",
      message:
        presentationMode === "current"
          ? `Workspace started — ${session.problem_name}`
          : `Session ${session.session_id.slice(0, 8)} started — ${session.problem_name}`,
      severity: "system",
    });

    if (session.requested_backend) {
      entries.push({
        time: session.started_at_unix_ms + 1,
        icon: "⚙",
        message: `Backend: ${session.requested_backend.toUpperCase()} · Mode: ${session.execution_mode} · Precision: ${session.precision}`,
        severity: "info",
      });
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
          icon: "◆",
          message: `Mesh: ${parts.join(" · ")}`,
          severity: "info",
        });
      }
    }
  }

  // Solver progress milestones
  const milestones = [1, 10, 50, 100, 500, 1000, 5000, 10000];
  for (const m of milestones) {
    const row = scalarRows.find((r) => r.step === m);
    if (row) {
      entries.push({
        time: session ? session.started_at_unix_ms + m : now,
        icon: "→",
        message: `Step ${m}: t=${fmtTime(row.time)} dt=${fmtExp(row.solver_dt)} max_dm/dt=${fmtExp(row.max_dm_dt)}`,
        severity: "info",
      });
    }
  }

  // Current live state
  if (liveState && liveState.step > 0) {
    entries.push({
      time: liveState.updated_at_unix_ms || now,
      icon: "●",
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
      icon: "✓",
      message: `Convergence criterion: max_dm/dt = ${fmtExp(liveState.max_dm_dt)} < ${CONVERGENCE_THRESHOLD.toExponential(0)} — approaching equilibrium`,
      severity: "success",
    });
  }

  // Completion / failure
  if (run?.status === "completed") {
    entries.push({
      time: session?.finished_at_unix_ms ?? now,
      icon: "✓",
      message: `Run completed — ${run.total_steps} steps in ${fmtDuration((session?.finished_at_unix_ms ?? 0) - (session?.started_at_unix_ms ?? 0))}`,
      severity: "success",
    });
  }
  if (run?.status === "failed" || error) {
    entries.push({
      time: now,
      icon: "✗",
      message: error ? `Error: ${error}` : "Run failed",
      severity: "error",
    });
  }

  // Connection status
  if (connection === "disconnected") {
    entries.push({
      time: now,
      icon: "⚠",
      message:
        presentationMode === "current"
          ? "Live connection lost — attempting reconnect…"
          : "SSE connection lost — attempting reconnect…",
      severity: "warn",
    });
  }

  return entries;
}

/* ── Component ─────────────────────────────────────────────── */

const TABS: { value: ConsoleTab; label: string }[] = [
  { value: "live", label: "Live" },
  { value: "log", label: "Log" },
  { value: "energy", label: "Energy" },
  { value: "perf", label: "Perf" },
];

export default function EngineConsole({
  session,
  run,
  liveState,
  scalarRows,
  artifacts,
  connection,
  error,
  presentationMode = "session",
}: EngineConsoleProps) {
  const [activeTab, setActiveTab] = useState<ConsoleTab>("live");
  const logContainerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  const logEntries = useMemo(
    () => buildLogEntries(session, run, liveState, scalarRows, connection, error, presentationMode),
    [session, run, liveState, scalarRows, connection, error, presentationMode],
  );

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

  // Convergence metric: normalize max_dm_dt to a 0-100 progress bar
  // max_dm_dt < 1e-5 is "converged", > 1e2 is "diverged"
  const dmDtLog = liveState?.max_dm_dt
    ? Math.log10(Math.max(liveState.max_dm_dt, 1e-12))
    : 0;
  const convergencePct = Math.max(0, Math.min(100, ((7 + dmDtLog) / 7) * 100)); // -12→0%, -5→100%
  // Actually: lower dm/dt = more converged, so invert
  const convergenceDisplay = Math.max(0, Math.min(100, 100 - convergencePct));

  return (
    <div className={s.console}>
      {/* ─── Header Bar ──────────────────────────────── */}
      <div className={s.headerBar}>
        <span className={s.headerTitle}>Engine Console</span>
        <span className={s.statusDot} data-status={liveState?.finished || run?.status === "completed" ? "completed" : connection} />
        <span className={s.statusLabel}>
          {liveState?.finished || run?.status === "completed"
            ? "Completed"
            : connection === "connected"
            ? "Live"
            : connection === "connecting"
            ? "Connecting…"
            : "Offline"}
        </span>
        {session && (
          <span className={s.statusLabel} style={{ marginLeft: "auto" }}>
            {session.problem_name} · {session.requested_backend.toUpperCase()}
          </span>
        )}
      </div>

      {/* ─── Tab bar ─────────────────────────────────── */}
      <div className={s.tabBar}>
        {TABS.map((tab) => (
          <button
            key={tab.value}
            className={s.tab}
            data-active={activeTab === tab.value}
            onClick={() => setActiveTab(tab.value)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* ─── Tab content ─────────────────────────────── */}
      <div className={s.tabContent}>
        {activeTab === "live" && (
          <>
            {/* Live telemetry grid */}
            <div className={s.telemetryGrid}>
              <div className={s.metricCell}>
                <span className={s.metricLabel}>Status</span>
                <span className={s.metricValue} style={{
                  color: run?.status === "completed" ? "#35b779"
                    : session?.status === "running" ? "hsl(210, 80%, 72%)"
                    : run?.status === "failed" ? "#cf6256" : undefined
                }}>
                  {session?.status ?? "idle"}
                </span>
              </div>
              <div className={s.metricCell}>
                <span className={s.metricLabel}>Step</span>
                <span className={s.metricValue}>{(liveState?.step ?? run?.total_steps ?? 0).toLocaleString()}</span>
              </div>
              <div className={s.metricCell}>
                <span className={s.metricLabel}>Sim Time</span>
                <span className={s.metricValue}>{fmtTime(liveState?.time ?? run?.final_time ?? 0)}</span>
              </div>
              <div className={s.metricCell}>
                <span className={s.metricLabel}>Δt</span>
                <span className={s.metricValue}>{fmtSI(liveState?.dt ?? 0, "s")}</span>
              </div>
              <div className={s.metricCell}>
                <span className={s.metricLabel}>max dm/dt</span>
                <span className={s.metricValue} style={{
                  color: (liveState?.max_dm_dt ?? 0) < 1e-5 ? "#35b779" : undefined
                }}>
                  {fmtExp(liveState?.max_dm_dt ?? 0)}
                </span>
              </div>
              <div className={s.metricCell}>
                <span className={s.metricLabel}>max |H_eff|</span>
                <span className={s.metricValue}>{fmtExp(liveState?.max_h_eff ?? 0)}</span>
              </div>
              <div className={s.metricCell}>
                <span className={s.metricLabel}>Wall Time</span>
                <span className={s.metricValue}>{fmtDuration(elapsed)}</span>
              </div>
              <div className={s.metricCell}>
                <span className={s.metricLabel}>Throughput</span>
                <span className={s.metricValue}>{stepsPerSec > 0 ? `${stepsPerSec.toFixed(1)} st/s` : "—"}</span>
              </div>
            </div>

            {/* Convergence bars */}
            <div style={{ padding: "0.4rem 0.75rem 0.65rem" }}>
              <div className={s.convergenceRow}>
                <span className={s.convergenceLabel}>Convergence</span>
                <div className={s.convergenceTrack}>
                  <div
                    className={s.convergenceFill}
                    style={{
                      width: `${convergenceDisplay}%`,
                      background: convergenceDisplay > 80 ? "#35b779"
                        : convergenceDisplay > 40 ? "#fde725" : "#cf6256",
                    }}
                  />
                </div>
                <span className={s.convergenceValue}>
                  {convergenceDisplay.toFixed(0)}%
                </span>
              </div>
              <div className={s.convergenceRow}>
                <span className={s.convergenceLabel}>Memory est.</span>
                <div className={s.convergenceTrack}>
                  <div
                    className={s.convergenceFill}
                    style={{
                      width: `${Math.min(100, (artifacts.length / 20) * 100)}%`,
                      background: "hsl(210, 60%, 50%)",
                    }}
                  />
                </div>
                <span className={s.convergenceValue}>
                  {artifacts.length} files
                </span>
              </div>
            </div>
          </>
        )}

        {activeTab === "log" && (
          <div
            className={s.logContainer}
            ref={logContainerRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
              setAutoScroll(atBottom);
            }}
          >
            {logEntries.length === 0 ? (
              <div style={{ padding: "1rem", color: "var(--text-3)", fontSize: "0.82rem", textAlign: "center" }}>
                Waiting for events…
              </div>
            ) : (
              logEntries.map((entry, i) => (
                <div key={i} className={s.logEntry}>
                  <span className={s.logTime}>
                    {session
                      ? `+${((entry.time - session.started_at_unix_ms) / 1000).toFixed(1)}s`
                      : "—"}
                  </span>
                  <span className={s.logIcon}>{entry.icon}</span>
                  <span className={s.logMessage} data-severity={entry.severity}>
                    {entry.message}
                  </span>
                </div>
              ))
            )}
          </div>
        )}

        {activeTab === "energy" && (
          <div className={s.energyGrid}>
            <div className={s.energyCard} data-tone="exchange">
              <span className={s.metricLabel}>E_exchange</span>
              <span className={s.metricValue}>
                {fmtSI(liveState?.e_ex ?? run?.final_e_ex ?? 0, "J")}
              </span>
            </div>
            <div className={s.energyCard} data-tone="demag">
              <span className={s.metricLabel}>E_demag</span>
              <span className={s.metricValue}>
                {fmtSI(liveState?.e_demag ?? run?.final_e_demag ?? 0, "J")}
              </span>
            </div>
            <div className={s.energyCard} data-tone="external">
              <span className={s.metricLabel}>E_ext</span>
              <span className={s.metricValue}>
                {fmtSI(liveState?.e_ext ?? run?.final_e_ext ?? 0, "J")}
              </span>
            </div>
            <div className={s.energyCard} data-tone="total">
              <span className={s.metricLabel}>E_total</span>
              <span className={s.metricValue}>
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
                  <div className={s.energyCard} data-tone="neutral">
                    <span className={s.metricLabel}>ΔE_total / step</span>
                    <span className={s.metricValue} style={{
                      color: dE < 0 ? "#35b779" : "#cf6256"
                    }}>
                      {dStep > 0 ? fmtExp(dE / dStep) : "—"}
                    </span>
                  </div>
                  <div className={s.energyCard} data-tone="neutral">
                    <span className={s.metricLabel}>History points</span>
                    <span className={s.metricValue}>{scalarRows.length}</span>
                  </div>
                </>
              );
            })()}
          </div>
        )}

        {activeTab === "perf" && (
          <div className={s.perfGrid}>
            <div className={s.metricCell}>
              <span className={s.metricLabel}>Backend</span>
              <span className={s.metricValue}>{session?.requested_backend?.toUpperCase() ?? "—"}</span>
            </div>
            <div className={s.metricCell}>
              <span className={s.metricLabel}>Mode</span>
              <span className={s.metricValue}>{session?.execution_mode ?? "—"}</span>
            </div>
            <div className={s.metricCell}>
              <span className={s.metricLabel}>Precision</span>
              <span className={s.metricValue}>{session?.precision ?? "—"}</span>
            </div>
            <div className={s.metricCell}>
              <span className={s.metricLabel}>Total Steps</span>
              <span className={s.metricValue}>{(liveState?.step ?? run?.total_steps ?? 0).toLocaleString()}</span>
            </div>
            <div className={s.metricCell}>
              <span className={s.metricLabel}>Throughput</span>
              <span className={s.metricValue}>{stepsPerSec > 0 ? `${stepsPerSec.toFixed(1)} st/s` : "—"}</span>
            </div>
            <div className={s.metricCell}>
              <span className={s.metricLabel}>Wall/step</span>
              <span className={s.metricValue}>{wallTimePerStep > 0 ? `${wallTimePerStep.toFixed(2)} ms` : "—"}</span>
            </div>
            <div className={s.metricCell}>
              <span className={s.metricLabel}>Elapsed</span>
              <span className={s.metricValue}>{fmtDuration(elapsed)}</span>
            </div>
            <div className={s.metricCell}>
              <span className={s.metricLabel}>Artifacts</span>
              <span className={s.metricValue}>{artifacts.length}</span>
            </div>

            {/* Throughput bar */}
            <div className={s.metricCell} style={{ gridColumn: "1 / -1" }}>
              <span className={s.metricLabel}>Throughput (steps/sec)</span>
              <div className={s.perfBar}>
                <div
                  className={s.perfBarFill}
                  style={{
                    width: `${Math.min(100, (stepsPerSec / 100) * 100)}%`,
                    background: stepsPerSec > 50 ? "#35b779" : stepsPerSec > 10 ? "#fde725" : "hsl(210, 60%, 50%)",
                  }}
                />
              </div>
              <span className={s.metricValue} style={{ fontSize: "0.72rem", marginTop: "0.2rem" }}>
                {stepsPerSec > 0 ? `${stepsPerSec.toFixed(2)} steps/sec` : "Waiting for data…"}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
