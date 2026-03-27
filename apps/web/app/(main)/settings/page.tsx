"use client";

import { useEffect, useState, useCallback } from "react";
import { resolveApiBase } from "@/lib/apiBase";

/* ── Types ───────────────────────────────────────── */

interface ServerConfig {
  backend: string;
  execution_mode: string;
  precision: string;
  problem_name: string;
  script_path: string | null;
  artifact_dir: string | null;
  status: string;
  plan_summary: Record<string, unknown> | null;
}

type ConnectionState = "idle" | "loading" | "connected" | "error";

/* ── Data fetching ───────────────────────────────── */

function useServerConfig() {
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("idle");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    const base = resolveApiBase();
    setConnection("loading");
    setError(null);
    fetch(`${base}/v1/live/current/bootstrap`, { cache: "no-store" })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        const session = data?.session;
        setConfig({
          backend: session?.requested_backend ?? "unknown",
          execution_mode: session?.execution_mode ?? "unknown",
          precision: session?.precision ?? "unknown",
          problem_name: session?.problem_name ?? "—",
          script_path: session?.script_path ?? null,
          artifact_dir: session?.artifact_dir ?? null,
          status: session?.status ?? data?.live_state?.status ?? "idle",
          plan_summary: session?.plan_summary ?? null,
        });
        setConnection("connected");
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Connection failed");
        setConnection("error");
      });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { config, connection, error, refresh };
}

/* ── Page ────────────────────────────────────────── */

export default function SettingsPage() {
  const { config, connection, error, refresh } = useServerConfig();

  const plan = config?.plan_summary;
  const meshInfo = plan
    ? [
        plan.n_nodes ? `${(plan.n_nodes as number).toLocaleString()} nodes` : null,
        plan.n_elements ? `${(plan.n_elements as number).toLocaleString()} elements` : null,
        plan.grid_cells
          ? `grid ${(plan.grid_cells as number[])[0]}×${(plan.grid_cells as number[])[1]}×${(plan.grid_cells as number[])[2]}`
          : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : null;

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Settings</h1>
        <p className="page-subtitle">Platform configuration and live workspace state</p>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-4)" }}>
        {/* ── Connection Status ── */}
        <div className="card">
          <div className="card-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h2 className="card-title">Server Connection</h2>
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
            <SettingRow
              label="Status"
              value={
                connection === "connected"
                  ? "✓ Connected"
                  : connection === "loading"
                    ? "⟳ Loading…"
                    : connection === "error"
                      ? "✗ Disconnected"
                      : "○ Idle"
              }
              tone={connection === "connected" ? "success" : connection === "error" ? "error" : undefined}
            />
            <SettingRow label="API Endpoint" value={resolveApiBase()} />
            {error && <SettingRow label="Error" value={error} tone="error" />}
          </div>
        </div>

        {/* ── Execution Config ── */}
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">Execution Configuration</h2>
          </div>
          <div className="card-body">
            <SettingRow
              label="Backend"
              value={config?.backend?.toUpperCase() ?? "—"}
              muted={!config}
            />
            <SettingRow
              label="Execution Mode"
              value={config?.execution_mode ?? "—"}
              muted={!config}
            />
            <SettingRow
              label="Precision"
              value={config?.precision ?? "—"}
              muted={!config}
            />
            <SettingRow
              label="Workspace Status"
              value={config?.status ?? "—"}
              tone={
                config?.status === "running"
                  ? "success"
                  : config?.status === "awaiting_command"
                    ? "info"
                    : undefined
              }
              muted={!config}
            />
          </div>
        </div>

        {/* ── Active Problem ── */}
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">Active Problem</h2>
          </div>
          <div className="card-body">
            <SettingRow
              label="Problem Name"
              value={config?.problem_name ?? "—"}
              muted={!config}
            />
            {config?.script_path && (
              <SettingRow label="Script" value={config.script_path.split("/").pop() ?? "—"} />
            )}
            {config?.artifact_dir && (
              <SettingRow label="Output Directory" value={config.artifact_dir} />
            )}
            {meshInfo && <SettingRow label="Mesh" value={meshInfo} />}
          </div>
        </div>

        {/* ── GPU Configuration ── */}
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">GPU Configuration</h2>
          </div>
          <div className="card-body">
            <SettingRow label="CUDA Device" value="Not yet detected" muted />
            <SettingRow label="CUDA Toolkit" value="—" muted />
            <SettingRow label="GPU Backend Status" value="Phase 2" muted />
            <p style={{ fontSize: "var(--text-sm)", color: "var(--text-muted)", marginTop: "var(--sp-2)" }}>
              GPU acceleration will be available when the CUDA backend is implemented.
            </p>
          </div>
        </div>

        {/* ── Appearance ── */}
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">Appearance</h2>
          </div>
          <div className="card-body">
            <p style={{ fontSize: "var(--text-sm)", color: "var(--text-muted)" }}>
              Use the sun/moon icon in the top bar to toggle between dark and light themes.
            </p>
          </div>
        </div>
      </div>
    </>
  );
}

/* ── SettingRow ───────────────────────────────────── */

function SettingRow({
  label,
  value,
  muted,
  tone,
}: {
  label: string;
  value: string;
  muted?: boolean;
  tone?: "success" | "error" | "info";
}) {
  const toneColor =
    tone === "success"
      ? "var(--status-success, #34d399)"
      : tone === "error"
        ? "var(--status-error, #f87171)"
        : tone === "info"
          ? "var(--status-info, #60a5fa)"
          : undefined;

  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "var(--sp-3) 0",
        borderBottom: "1px solid var(--border-subtle)",
      }}
    >
      <span style={{ fontSize: "var(--text-base)", color: "var(--text-secondary)" }}>
        {label}
      </span>
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-sm)",
          color: toneColor ?? (muted ? "var(--text-muted)" : "var(--text-primary)"),
          fontWeight: tone ? 600 : undefined,
        }}
      >
        {value}
      </span>
    </div>
  );
}
