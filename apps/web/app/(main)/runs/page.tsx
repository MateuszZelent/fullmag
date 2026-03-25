"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8080";

type SessionManifest = {
  session_id: string;
  run_id: string;
  status: string;
  script_path: string;
  problem_name: string;
  requested_backend: string;
  execution_mode: string;
  precision: string;
  artifact_dir: string;
  started_at_unix_ms: number;
  finished_at_unix_ms: number;
};

/* ── Helpers ─────────────────────────────────────────────── */

function statusAccent(status: string): "success" | "error" | "warning" | "info" {
  if (status === "completed") return "success";
  if (status === "failed") return "error";
  if (status === "running") return "warning";
  return "info";
}

function relativeTime(unix_ms: number): string {
  if (!unix_ms) return "—";
  const diff = Date.now() - unix_ms;
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function formatDuration(start: number, end: number): string {
  if (!start) return "—";
  const finish = end || Date.now();
  const ms = finish - start;
  if (ms < 1000) return `${ms}ms`;
  const secs = ms / 1000;
  if (secs < 60) return `${secs.toFixed(1)}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = Math.floor(secs % 60);
  return `${mins}m ${remSecs}s`;
}

function backendLabel(backend: string): { label: string; icon: string; color: string } {
  const b = backend?.toLowerCase() || "";
  if (b.includes("cuda") || b.includes("gpu"))
    return { label: "CUDA", icon: "⚡", color: "#22d3ee" };
  if (b.includes("fem"))
    return { label: "FEM", icon: "△", color: "#a78bfa" };
  if (b.includes("fdm"))
    return { label: "FDM", icon: "▦", color: "#60a5fa" };
  if (b.includes("cpu"))
    return { label: "CPU", icon: "◉", color: "#94a3b8" };
  return { label: backend || "—", icon: "●", color: "#94a3b8" };
}

function precisionLabel(precision: string): { short: string; color: string } {
  const p = precision?.toLowerCase() || "";
  if (p.includes("single") || p === "f32")
    return { short: "FP32", color: "#fbbf24" };
  if (p.includes("double") || p === "f64")
    return { short: "FP64", color: "#34d399" };
  return { short: precision || "—", color: "#94a3b8" };
}

/* ── Pill Component ─────────────────────────────────────── */

function Pill({
  icon,
  label,
  color,
}: {
  icon?: string;
  label: string;
  color: string;
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
        padding: "2px 8px",
        borderRadius: "var(--radius-full)",
        fontSize: "var(--text-xs)",
        fontWeight: 600,
        lineHeight: 1.4,
        background: `${color}18`,
        color: color,
        border: `1px solid ${color}30`,
        whiteSpace: "nowrap",
      }}
    >
      {icon && <span style={{ fontSize: "10px" }}>{icon}</span>}
      {label}
    </span>
  );
}

/* ── Stats Bar ──────────────────────────────────────────── */

function StatsBar({ sessions }: { sessions: SessionManifest[] }) {
  const running = sessions.filter((s) => s.status === "running").length;
  const completed = sessions.filter((s) => s.status === "completed").length;
  const failed = sessions.filter((s) => s.status === "failed").length;
  const fdm = sessions.filter((s) => s.requested_backend?.toLowerCase().includes("fdm")).length;
  const fem = sessions.filter((s) => s.requested_backend?.toLowerCase().includes("fem")).length;
  const cuda = sessions.filter((s) =>
    s.requested_backend?.toLowerCase().includes("cuda") ||
    s.execution_mode?.toLowerCase().includes("cuda")
  ).length;

  return (
    <div
      style={{
        display: "flex",
        gap: "var(--sp-4)",
        flexWrap: "wrap",
        padding: "var(--sp-3) var(--sp-4)",
        background: "var(--bg-raised)",
        borderRadius: "var(--radius-md)",
        border: "1px solid var(--border)",
        marginBottom: "var(--sp-4)",
      }}
    >
      <StatItem label="Total" value={sessions.length} color="var(--text-primary)" />
      <StatItem label="Running" value={running} color="var(--warning)" />
      <StatItem label="Completed" value={completed} color="var(--success)" />
      <StatItem label="Failed" value={failed} color="var(--error)" />
      <div style={{ borderLeft: "1px solid var(--border)", margin: "0 var(--sp-1)" }} />
      <StatItem label="FDM" value={fdm} color="#60a5fa" />
      <StatItem label="FEM" value={fem} color="#a78bfa" />
      <StatItem label="CUDA" value={cuda} color="#22d3ee" />
    </div>
  );
}

function StatItem({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ textAlign: "center", minWidth: "48px" }}>
      <div style={{ fontSize: "var(--text-lg)", fontWeight: 700, color, lineHeight: 1.2 }}>
        {value}
      </div>
      <div style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)", marginTop: "2px" }}>
        {label}
      </div>
    </div>
  );
}

/* ── Main Page ──────────────────────────────────────────── */

export default function RunsIndexPage() {
  const [sessions, setSessions] = useState<SessionManifest[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const response = await fetch(`${API_BASE}/v1/sessions`, { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = (await response.json()) as SessionManifest[];
        if (!cancelled) {
          setSessions(payload);
          setError(null);
        }
      } catch (nextError) {
        if (!cancelled) {
          setError(nextError instanceof Error ? nextError.message : String(nextError));
        }
      }
    };

    void load();
    const id = window.setInterval(() => void load(), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const latest = useMemo(() => sessions[0] ?? null, [sessions]);

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Simulation Runs</h1>
        <p className="page-subtitle">
          Monitor active and completed simulations
        </p>
      </div>

      {sessions.length > 0 && <StatsBar sessions={sessions} />}

      {/* ── Latest Session Hero ── */}
      {latest && (
        <section style={{ marginBottom: "var(--sp-6)" }}>
          <Link
            href={`/runs/${latest.session_id}`}
            style={{
              display: "block",
              textDecoration: "none",
              color: "inherit",
              background: "linear-gradient(135deg, var(--surface-2), var(--surface-3))",
              border: "1px solid var(--border-interactive)",
              borderRadius: "var(--radius-lg)",
              padding: "var(--sp-5) var(--sp-6)",
              transition: "transform var(--duration-fast), box-shadow var(--duration-fast)",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = "translateY(-1px)";
              e.currentTarget.style.boxShadow = "0 4px 20px rgba(0,0,0,0.3)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = "translateY(0)";
              e.currentTarget.style.boxShadow = "none";
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "var(--sp-3)" }}>
              <div>
                <div style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)", marginBottom: "var(--sp-1)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                  Latest Run
                </div>
                <div style={{ fontSize: "var(--text-xl)", fontWeight: 700, color: "var(--text-primary)" }}>
                  {latest.problem_name}
                </div>
              </div>
              <span className={`badge badge-${statusAccent(latest.status)}`}>
                <span className="badge-dot" />
                {latest.status}
              </span>
            </div>
            <div style={{ display: "flex", gap: "var(--sp-3)", flexWrap: "wrap", alignItems: "center" }}>
              {(() => {
                const b = backendLabel(latest.requested_backend);
                return <Pill icon={b.icon} label={b.label} color={b.color} />;
              })()}
              <Pill label={latest.execution_mode} color="#94a3b8" />
              {(() => {
                const p = precisionLabel(latest.precision);
                return <Pill label={p.short} color={p.color} />;
              })()}
              <span style={{ color: "var(--text-muted)", fontSize: "var(--text-sm)", marginLeft: "auto" }}>
                {relativeTime(latest.started_at_unix_ms)} · {formatDuration(latest.started_at_unix_ms, latest.finished_at_unix_ms)}
              </span>
            </div>
          </Link>
        </section>
      )}

      {/* ── Sessions Table ── */}
      <section>
        <div className="card">
          <div className="card-header">
            <div>
              <h2 className="card-title">All Sessions</h2>
              <p className="card-subtitle">
                {sessions.length} simulation{sessions.length !== 1 ? "s" : ""} recorded
              </p>
            </div>
          </div>
          <div className="card-body" style={{ padding: 0 }}>
            {error && (
              <p style={{ color: "var(--error)", padding: "var(--sp-4)" }}>{error}</p>
            )}
            {!error && sessions.length === 0 && (
              <div style={{ color: "var(--text-muted)", padding: "var(--sp-6)", textAlign: "center", lineHeight: 1.8 }}>
                No sessions yet. Run:
                <div style={{ marginTop: "var(--sp-2)" }}>
                  <code style={{ padding: "var(--sp-1) var(--sp-3)", background: "var(--surface-2)", borderRadius: "var(--radius-sm)", fontSize: "var(--text-sm)" }}>
                    fullmag examples/exchange_relax.py --until 2e-9
                  </code>
                </div>
              </div>
            )}
            {sessions.length > 0 && (
              <div style={{ overflowX: "auto" }}>
                {/* Table header */}
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "2fr 100px 90px 70px 80px 100px 80px",
                    gap: "var(--sp-2)",
                    padding: "var(--sp-2) var(--sp-4)",
                    fontSize: "var(--text-xs)",
                    color: "var(--text-muted)",
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    fontWeight: 600,
                    borderBottom: "1px solid var(--border)",
                  }}
                >
                  <span>Problem</span>
                  <span>Backend</span>
                  <span>Mode</span>
                  <span>Prec.</span>
                  <span>Status</span>
                  <span>Started</span>
                  <span>Duration</span>
                </div>

                {/* Table rows */}
                {sessions.map((session) => {
                  const b = backendLabel(session.requested_backend);
                  const p = precisionLabel(session.precision);
                  return (
                    <Link
                      key={session.session_id}
                      href={`/runs/${session.session_id}`}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "2fr 100px 90px 70px 80px 100px 80px",
                        gap: "var(--sp-2)",
                        alignItems: "center",
                        padding: "var(--sp-3) var(--sp-4)",
                        borderBottom: "1px solid var(--border)",
                        textDecoration: "none",
                        color: "inherit",
                        transition: "background var(--duration-fast)",
                      }}
                      onMouseEnter={(e) =>
                        (e.currentTarget.style.background = "var(--surface-2)")
                      }
                      onMouseLeave={(e) =>
                        (e.currentTarget.style.background = "transparent")
                      }
                    >
                      {/* Problem name + ID */}
                      <div>
                        <div style={{ fontWeight: 600, color: "var(--text-primary)", fontSize: "var(--text-base)" }}>
                          {session.problem_name}
                        </div>
                        <div style={{ color: "var(--text-muted)", fontSize: "var(--text-xs)", fontFamily: "var(--font-mono)", opacity: 0.7 }}>
                          {session.session_id.slice(0, 8)}
                        </div>
                      </div>

                      {/* Backend pill */}
                      <div>
                        <Pill icon={b.icon} label={b.label} color={b.color} />
                      </div>

                      {/* Execution mode */}
                      <div style={{ fontSize: "var(--text-sm)", color: "var(--text-muted)" }}>
                        {session.execution_mode}
                      </div>

                      {/* Precision */}
                      <div>
                        <Pill label={p.short} color={p.color} />
                      </div>

                      {/* Status badge */}
                      <div>
                        <span className={`badge badge-${statusAccent(session.status)}`}>
                          <span className="badge-dot" />
                          {session.status}
                        </span>
                      </div>

                      {/* Relative time */}
                      <div style={{ fontSize: "var(--text-sm)", color: "var(--text-muted)" }}>
                        {relativeTime(session.started_at_unix_ms)}
                      </div>

                      {/* Duration */}
                      <div style={{ fontSize: "var(--text-sm)", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
                        {formatDuration(session.started_at_unix_ms, session.finished_at_unix_ms)}
                      </div>
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </section>
    </>
  );
}
