"use client";

import { useState, useEffect, useCallback } from "react";
import { resolveApiBase } from "@/lib/apiBase";

/* ── Types ───────────────────────────────────────── */

interface SessionSummary {
  session_id: string;
  problem_name: string;
  requested_backend: string;
  precision: string;
  status: string;
  started_at_unix_ms: number;
  finished_at_unix_ms: number;
  script_path: string | null;
  plan_summary: Record<string, unknown> | null;
}

interface EnergySnapshot {
  e_ex: number;
  e_demag: number;
  e_ext: number;
  e_total: number;
  step: number;
  time: number;
  max_dm_dt: number;
}

type LoadState = "idle" | "loading" | "loaded" | "error";

/* ── Helpers ─────────────────────────────────────── */

function fmtSI(v: number, unit: string): string {
  if (!Number.isFinite(v) || v === 0) return `0 ${unit}`;
  const abs = Math.abs(v);
  if (abs >= 1e6) return `${(v / 1e6).toPrecision(3)} M${unit}`;
  if (abs >= 1e3) return `${(v / 1e3).toPrecision(3)} k${unit}`;
  if (abs >= 1) return `${v.toPrecision(3)} ${unit}`;
  if (abs >= 1e-3) return `${(v * 1e3).toPrecision(3)} m${unit}`;
  if (abs >= 1e-6) return `${(v * 1e6).toPrecision(3)} µ${unit}`;
  if (abs >= 1e-9) return `${(v * 1e9).toPrecision(3)} n${unit}`;
  return `${v.toExponential(2)} ${unit}`;
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  return `${(ms / 60000).toFixed(1)} min`;
}

function fmtTimestamp(unix_ms: number): string {
  if (!unix_ms) return "—";
  return new Date(unix_ms).toLocaleString();
}

/* ── Page ────────────────────────────────────────── */

export default function VisualizationsPage() {
  const [session, setSession] = useState<SessionSummary | null>(null);
  const [energy, setEnergy] = useState<EnergySnapshot | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    const base = resolveApiBase();
    setLoadState("loading");
    setError(null);
    fetch(`${base}/v1/live/current/bootstrap`, { cache: "no-store" })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        setSession(data?.session ?? null);
        const live = data?.live_state?.latest_step;
        const rows = data?.scalar_rows;
        if (live) {
          setEnergy({
            e_ex: live.e_ex ?? 0,
            e_demag: live.e_demag ?? 0,
            e_ext: live.e_ext ?? 0,
            e_total: live.e_total ?? 0,
            step: live.step ?? 0,
            time: live.time ?? 0,
            max_dm_dt: live.max_dm_dt ?? 0,
          });
        } else if (Array.isArray(rows) && rows.length > 0) {
          const last = rows[rows.length - 1];
          setEnergy({
            e_ex: last.e_ex ?? 0,
            e_demag: last.e_demag ?? 0,
            e_ext: last.e_ext ?? 0,
            e_total: last.e_total ?? 0,
            step: last.step ?? 0,
            time: last.time ?? 0,
            max_dm_dt: last.max_dm_dt ?? 0,
          });
        }
        setLoadState("loaded");
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Connection failed");
        setLoadState("error");
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const plan = session?.plan_summary;

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Visualizations</h1>
        <p className="page-subtitle">Compare solver results and analyze convergence</p>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-4)" }}>
        {/* ── Current Session Summary ── */}
        <div className="card">
          <div className="card-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h2 className="card-title">Current Session</h2>
            <button
              onClick={load}
              style={{
                appearance: "none",
                border: "1px solid var(--border-subtle)",
                borderRadius: "6px",
                background: "var(--surface-2)",
                color: "var(--text-secondary)",
                padding: "0.35rem 0.75rem",
                fontSize: "var(--text-sm)",
                cursor: "pointer",
              }}
            >
              ⟳ Refresh
            </button>
          </div>
          <div className="card-body">
            {loadState === "loading" && (
              <p style={{ color: "var(--text-muted)" }}>Loading session data…</p>
            )}
            {loadState === "error" && (
              <p style={{ color: "var(--status-error, #f87171)" }}>
                {error ?? "Failed to connect."}  No active session available.
              </p>
            )}
            {session && (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: "var(--sp-3)" }}>
                <MetricCard label="Problem" value={session.problem_name} />
                <MetricCard label="Backend" value={session.requested_backend.toUpperCase()} />
                <MetricCard label="Status" value={session.status} tone={session.status === "running" ? "success" : undefined} />
                <MetricCard label="Precision" value={session.precision} />
                <MetricCard label="Started" value={fmtTimestamp(session.started_at_unix_ms)} />
                {session.finished_at_unix_ms > session.started_at_unix_ms && (
                  <MetricCard
                    label="Duration"
                    value={fmtDuration(session.finished_at_unix_ms - session.started_at_unix_ms)}
                  />
                )}
                {plan?.n_nodes != null && (
                  <MetricCard label="Mesh Nodes" value={`${(plan.n_nodes as number).toLocaleString()}`} />
                )}
                {plan?.n_elements != null && (
                  <MetricCard label="Mesh Elements" value={`${(plan.n_elements as number).toLocaleString()}`} />
                )}
                {plan?.grid_cells != null && (
                  <MetricCard
                    label="Grid"
                    value={`${(plan.grid_cells as number[])[0]}×${(plan.grid_cells as number[])[1]}×${(plan.grid_cells as number[])[2]}`}
                  />
                )}
              </div>
            )}
          </div>
        </div>

        {/* ── Energy Comparison ── */}
        {energy && (
          <div className="card">
            <div className="card-header">
              <h2 className="card-title">Energy Summary</h2>
            </div>
            <div className="card-body">
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: "var(--sp-3)" }}>
                <MetricCard label="E_exchange" value={fmtSI(energy.e_ex, "J")} tone="exchange" />
                <MetricCard label="E_demag" value={fmtSI(energy.e_demag, "J")} tone="demag" />
                <MetricCard label="E_external" value={fmtSI(energy.e_ext, "J")} tone="external" />
                <MetricCard label="E_total" value={fmtSI(energy.e_total, "J")} tone="total" />
                <MetricCard label="Step" value={energy.step.toLocaleString()} />
                <MetricCard label="Sim Time" value={fmtSI(energy.time, "s")} />
                <MetricCard label="max dm/dt" value={energy.max_dm_dt.toExponential(3)} tone={energy.max_dm_dt < 1e-5 ? "success" : undefined} />
              </div>
            </div>
          </div>
        )}

        {/* ── Comparison Tools ── */}
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">Comparison Tools</h2>
          </div>
          <div className="card-body">
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: "var(--sp-3)" }}>
              <ToolCard
                title="FDM vs FEM"
                description="Compare finite-difference and finite-element solutions on the same geometry. Requires completed runs from both backends."
                available={false}
                reason="Requires session history API"
              />
              <ToolCard
                title="Parameter Sweep"
                description="Side-by-side magnetization snapshots across different material or geometry parameters."
                available={false}
                reason="Requires batch run management"
              />
              <ToolCard
                title="Convergence Analysis"
                description="Overlay convergence curves from multiple runs to compare integrator performance."
                available={loadState === "loaded"}
                reason={loadState === "loaded" ? "Use Charts tab in Dashboard" : "No session available"}
                linkHref="/"
                linkLabel="→ Open Dashboard"
              />
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

/* ── Metric card ─────────────────────────────────────── */

const TONE_COLORS: Record<string, string> = {
  exchange: "hsl(160, 65%, 55%)",
  demag: "hsl(280, 60%, 65%)",
  external: "hsl(30, 85%, 60%)",
  total: "hsl(210, 70%, 65%)",
  success: "hsl(145, 70%, 55%)",
};

function MetricCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div
      style={{
        padding: "var(--sp-3)",
        borderRadius: "8px",
        background: "var(--surface-2, #0f1728)",
        border: "1px solid var(--border-subtle)",
        borderLeft: tone && TONE_COLORS[tone] ? `3px solid ${TONE_COLORS[tone]}` : undefined,
      }}
    >
      <div style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 700 }}>
        {label}
      </div>
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-base)",
          color: tone && TONE_COLORS[tone] ? TONE_COLORS[tone] : "var(--text-primary)",
          fontWeight: 600,
          marginTop: "2px",
        }}
      >
        {value}
      </div>
    </div>
  );
}

/* ── Tool card ─────────────────────────────────────── */

function ToolCard({
  title,
  description,
  available,
  reason,
  linkHref,
  linkLabel,
}: {
  title: string;
  description: string;
  available: boolean;
  reason?: string;
  linkHref?: string;
  linkLabel?: string;
}) {
  return (
    <div
      style={{
        padding: "var(--sp-4)",
        borderRadius: "8px",
        background: "var(--surface-2, #0f1728)",
        border: "1px solid var(--border-subtle)",
        opacity: available ? 1 : 0.6,
      }}
    >
      <div style={{ fontSize: "var(--text-base)", fontWeight: 700, color: "var(--text-primary)", marginBottom: "var(--sp-2)" }}>
        {title}
      </div>
      <div style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", marginBottom: "var(--sp-3)" }}>
        {description}
      </div>
      <div style={{ fontSize: "var(--text-xs)", color: available ? "var(--status-success, #34d399)" : "var(--text-muted)" }}>
        {available ? "✓ Available" : `○ ${reason ?? "Not available"}`}
      </div>
      {available && linkHref && (
        <a
          href={linkHref}
          style={{
            display: "inline-block",
            marginTop: "var(--sp-2)",
            fontSize: "var(--text-sm)",
            color: "var(--ide-accent, #3b82f6)",
            textDecoration: "none",
          }}
        >
          {linkLabel}
        </a>
      )}
    </div>
  );
}
