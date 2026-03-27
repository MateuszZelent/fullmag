"use client";

import { useState, useEffect, useCallback } from "react";
import { resolveApiBase } from "@/lib/apiBase";

/* ── Types ───────────────────────────────────────── */

interface ActiveSession {
  problem_name: string;
  requested_backend: string;
  execution_mode: string;
  precision: string;
  status: string;
  script_path: string | null;
  artifact_dir: string | null;
  started_at_unix_ms: number;
}

interface ScriptEntry {
  name: string;
  path: string;
  backend: string;
  status: "idle" | "running" | "completed";
}

type ConnectionState = "idle" | "loading" | "connected" | "error";

/* ── Helpers ─────────────────────────────────────── */

function fmtTimestamp(unix_ms: number): string {
  if (!unix_ms) return "—";
  return new Date(unix_ms).toLocaleString();
}

/* ── Page ────────────────────────────────────────── */

export default function SimulationsPage() {
  const [activeSession, setActiveSession] = useState<ActiveSession | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>("idle");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    const base = resolveApiBase();
    setConnectionState("loading");
    setError(null);
    fetch(`${base}/v1/live/current/bootstrap`, { cache: "no-store" })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        const session = data?.session;
        if (session) {
          setActiveSession({
            problem_name: session.problem_name ?? "—",
            requested_backend: session.requested_backend ?? "unknown",
            execution_mode: session.execution_mode ?? "unknown",
            precision: session.precision ?? "unknown",
            status: session.status ?? "idle",
            script_path: session.script_path ?? null,
            artifact_dir: session.artifact_dir ?? null,
            started_at_unix_ms: session.started_at_unix_ms ?? 0,
          });
        }
        setConnectionState("connected");
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Connection failed");
        setConnectionState("error");
      });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Example scripts — in future these would come from a file listing API
  const exampleScripts: ScriptEntry[] = [
    { name: "std_problem_4.py", path: "scripts/std_problem_4.py", backend: "FDM", status: activeSession?.script_path?.includes("std_problem_4") ? "running" : "idle" },
    { name: "vortex_relax.py", path: "scripts/vortex_relax.py", backend: "FEM", status: "idle" },
    { name: "skyrmion_nucleation.py", path: "scripts/skyrmion_nucleation.py", backend: "FDM", status: "idle" },
    { name: "exchange_coupling.py", path: "scripts/exchange_coupling.py", backend: "FEM", status: "idle" },
  ];

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Simulations</h1>
        <p className="page-subtitle">Manage problem definitions, scripts, and runs</p>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-4)" }}>
        {/* ── Active Session ── */}
        <div className="card">
          <div className="card-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h2 className="card-title">Active Workspace</h2>
            <button
              onClick={refresh}
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
            {connectionState === "loading" && (
              <p style={{ color: "var(--text-muted)" }}>Connecting to workspace…</p>
            )}
            {connectionState === "error" && (
              <p style={{ color: "var(--status-error, #f87171)" }}>
                {error ?? "Failed to connect."} Start a simulation to see it here.
              </p>
            )}
            {activeSession && (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: "var(--sp-3)" }}>
                <InfoCell label="Problem" value={activeSession.problem_name} />
                <InfoCell label="Backend" value={activeSession.requested_backend.toUpperCase()} />
                <InfoCell
                  label="Status"
                  value={activeSession.status}
                  tone={
                    activeSession.status === "running"
                      ? "success"
                      : activeSession.status === "awaiting_command"
                        ? "info"
                        : activeSession.status === "completed"
                          ? "success"
                          : undefined
                  }
                />
                <InfoCell label="Mode" value={activeSession.execution_mode} />
                <InfoCell label="Precision" value={activeSession.precision} />
                <InfoCell label="Started" value={fmtTimestamp(activeSession.started_at_unix_ms)} />
                {activeSession.script_path && (
                  <InfoCell label="Script" value={activeSession.script_path.split("/").pop() ?? "—"} />
                )}
                {activeSession.artifact_dir && (
                  <InfoCell label="Output" value={activeSession.artifact_dir.split("/").pop() ?? "—"} />
                )}
              </div>
            )}
            {activeSession && (
              <div style={{ marginTop: "var(--sp-3)" }}>
                <a
                  href="/"
                  style={{
                    display: "inline-block",
                    padding: "0.5rem 1rem",
                    borderRadius: "6px",
                    background: "var(--ide-accent, #3b82f6)",
                    color: "white",
                    fontSize: "var(--text-sm)",
                    fontWeight: 600,
                    textDecoration: "none",
                  }}
                >
                  → Open in Dashboard
                </a>
              </div>
            )}
          </div>
        </div>

        {/* ── Script Library ── */}
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">Script Library</h2>
          </div>
          <div className="card-body">
            <p style={{ fontSize: "var(--text-sm)", color: "var(--text-muted)", marginBottom: "var(--sp-3)" }}>
              Available simulation scripts. In the future, you will be able to edit, validate, and launch scripts directly from here.
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
              {exampleScripts.map((script) => (
                <div
                  key={script.name}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 80px 100px",
                    gap: "var(--sp-3)",
                    padding: "var(--sp-3) var(--sp-4)",
                    borderRadius: "6px",
                    background: script.status === "running" ? "hsla(210, 70%, 50%, 0.08)" : "var(--surface-2, #0f1728)",
                    border: script.status === "running" ? "1px solid var(--ide-accent)" : "1px solid var(--border-subtle)",
                    alignItems: "center",
                  }}
                >
                  <div>
                    <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)", color: "var(--text-primary)", fontWeight: 600 }}>
                      {script.name}
                    </div>
                    <div style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>
                      {script.path}
                    </div>
                  </div>
                  <span style={{
                    fontSize: "var(--text-xs)",
                    fontWeight: 700,
                    color: "var(--text-secondary)",
                    textTransform: "uppercase",
                    textAlign: "center",
                  }}>
                    {script.backend}
                  </span>
                  <span style={{
                    fontSize: "var(--text-xs)",
                    fontWeight: 600,
                    color: script.status === "running" ? "var(--status-success, #34d399)" : "var(--text-muted)",
                    textAlign: "right",
                  }}>
                    {script.status === "running" ? "● Running" : script.status === "completed" ? "✓ Done" : "○ Idle"}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ── Planned Features ── */}
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">Planned Features</h2>
          </div>
          <div className="card-body">
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(250px, 1fr))", gap: "var(--sp-3)" }}>
              <FeatureCard title="Script Editor" description="Edit fullmag Python scripts with syntax highlighting and live validation" phase="Phase 2" />
              <FeatureCard title="Batch Runs" description="Queue multiple simulations with different parameters (field sweeps, geometry variations)" phase="Phase 3" />
              <FeatureCard title="Run History" description="Browse completed simulation runs, resume from snapshots, export results" phase="Phase 2" />
              <FeatureCard title="Template Library" description="Pre-built simulation templates for standard problems (SP1-5), vortices, skyrmions" phase="Phase 3" />
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

/* ── Info cell ───────────────────────────────────── */

function InfoCell({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "success" | "info";
}) {
  return (
    <div
      style={{
        padding: "var(--sp-3)",
        borderRadius: "8px",
        background: "var(--surface-2, #0f1728)",
        border: "1px solid var(--border-subtle)",
      }}
    >
      <div style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 700 }}>
        {label}
      </div>
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-sm)",
          color:
            tone === "success"
              ? "var(--status-success, #34d399)"
              : tone === "info"
                ? "var(--status-info, #60a5fa)"
                : "var(--text-primary)",
          fontWeight: 600,
          marginTop: "2px",
        }}
      >
        {value}
      </div>
    </div>
  );
}

/* ── Feature card ────────────────────────────────── */

function FeatureCard({
  title,
  description,
  phase,
}: {
  title: string;
  description: string;
  phase: string;
}) {
  return (
    <div
      style={{
        padding: "var(--sp-4)",
        borderRadius: "8px",
        background: "var(--surface-2, #0f1728)",
        border: "1px solid var(--border-subtle)",
        opacity: 0.7,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--sp-2)" }}>
        <span style={{ fontSize: "var(--text-base)", fontWeight: 700, color: "var(--text-primary)" }}>
          {title}
        </span>
        <span style={{
          fontSize: "var(--text-xs)",
          padding: "2px 8px",
          borderRadius: "4px",
          background: "var(--surface-3, #1a2744)",
          color: "var(--text-muted)",
          fontWeight: 600,
        }}>
          {phase}
        </span>
      </div>
      <div style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}>
        {description}
      </div>
    </div>
  );
}
