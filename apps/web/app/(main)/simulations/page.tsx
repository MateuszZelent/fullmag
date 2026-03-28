"use client";

import { useState, useEffect, useCallback } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { resolveApiBase } from "@/lib/apiBase";

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
type InfoTone = "success" | "info";

const pageStackClass = "flex flex-col gap-[var(--sp-4)]";
const autoFill200GridClass = "grid gap-[var(--sp-3)] [grid-template-columns:repeat(auto-fill,minmax(200px,1fr))]";
const autoFill250GridClass = "grid gap-[var(--sp-3)] [grid-template-columns:repeat(auto-fill,minmax(250px,1fr))]";
const refreshButtonClass = "inline-flex items-center rounded-md border border-[var(--ide-border-subtle)] bg-[var(--surface-2)] px-3 py-1.5 text-[length:var(--text-sm)] font-medium text-[var(--text-soft)] transition-colors hover:bg-[var(--surface-3)] hover:text-[var(--text-1)]";
const dashboardLinkClass = "inline-flex items-center rounded-md bg-[var(--ide-accent)] px-4 py-2 text-[length:var(--text-sm)] font-semibold text-white transition-colors hover:bg-[var(--ide-accent-hover)]";

function fmtTimestamp(unix_ms: number): string {
  if (!unix_ms) return "—";
  return new Date(unix_ms).toLocaleString();
}

function badgeVariantForTone(tone?: InfoTone) {
  if (tone === "success") return "success";
  if (tone === "info") return "info";
  return "outline";
}

function badgeVariantForScriptStatus(status: ScriptEntry["status"]) {
  if (status === "running") return "success";
  if (status === "completed") return "info";
  return "outline";
}

function statusLabelForScript(status: ScriptEntry["status"]) {
  if (status === "running") return "Running";
  if (status === "completed") return "Done";
  return "Idle";
}

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

  const exampleScripts: ScriptEntry[] = [
    {
      name: "std_problem_4.py",
      path: "scripts/std_problem_4.py",
      backend: "FDM",
      status: activeSession?.script_path?.includes("std_problem_4") ? "running" : "idle",
    },
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

      <div className={pageStackClass}>
        <section className="card">
          <div className="card-header">
            <h2 className="card-title">Active Workspace</h2>
            <button type="button" onClick={refresh} className={refreshButtonClass}>
              Refresh
            </button>
          </div>
          <div className="card-body">
            {connectionState === "loading" && (
              <p className="text-[length:var(--text-sm)] text-[var(--text-muted)]">Connecting to workspace…</p>
            )}
            {connectionState === "error" && (
              <p className="text-[length:var(--text-sm)] text-[var(--am-danger)]">
                {error ?? "Failed to connect."} Start a simulation to see it here.
              </p>
            )}
            {activeSession && (
              <div className={autoFill200GridClass}>
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
              <div className="mt-[var(--sp-3)]">
                <a href="/" className={dashboardLinkClass}>
                  Open in Dashboard
                </a>
              </div>
            )}
          </div>
        </section>

        <section className="card">
          <div className="card-header">
            <h2 className="card-title">Script Library</h2>
          </div>
          <div className="card-body">
            <p className="mb-[var(--sp-3)] text-[length:var(--text-sm)] text-[var(--text-muted)]">
              Available simulation scripts. In the future, you will be able to edit, validate, and launch scripts directly from here.
            </p>
            <div className="flex flex-col gap-0.5">
              {exampleScripts.map((script) => (
                <div
                  key={script.name}
                  className={cn(
                    "grid items-center gap-[var(--sp-3)] rounded-md border px-[var(--sp-4)] py-[var(--sp-3)] [grid-template-columns:minmax(0,1fr)_80px_100px]",
                    script.status === "running"
                      ? "border-[var(--ide-accent)] bg-[hsla(210,70%,50%,0.08)]"
                      : "border-[var(--ide-border-subtle)] bg-[var(--surface-2)]",
                  )}
                >
                  <div className="min-w-0">
                    <div className="truncate font-mono text-[length:var(--text-sm)] font-semibold text-[var(--text-1)]">
                      {script.name}
                    </div>
                    <div className="truncate text-[length:var(--text-xs)] text-[var(--text-muted)]">
                      {script.path}
                    </div>
                  </div>
                  <span className="text-center text-[length:var(--text-xs)] font-bold uppercase text-[var(--text-soft)]">
                    {script.backend}
                  </span>
                  <div className="flex justify-end">
                    <Badge variant={badgeVariantForScriptStatus(script.status)}>
                      {statusLabelForScript(script.status)}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="card">
          <div className="card-header">
            <h2 className="card-title">Planned Features</h2>
          </div>
          <div className="card-body">
            <div className={autoFill250GridClass}>
              <FeatureCard title="Script Editor" description="Edit fullmag Python scripts with syntax highlighting and live validation" phase="Phase 2" />
              <FeatureCard title="Batch Runs" description="Queue multiple simulations with different parameters (field sweeps, geometry variations)" phase="Phase 3" />
              <FeatureCard title="Run History" description="Browse completed simulation runs, resume from snapshots, export results" phase="Phase 2" />
              <FeatureCard title="Template Library" description="Pre-built simulation templates for standard problems (SP1-5), vortices, skyrmions" phase="Phase 3" />
            </div>
          </div>
        </section>
      </div>
    </>
  );
}

function InfoCell({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: InfoTone;
}) {
  return (
    <div className="rounded-lg border border-[var(--ide-border-subtle)] bg-[var(--surface-2)] p-[var(--sp-3)]">
      <div className="text-[length:var(--text-xs)] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">
        {label}
      </div>
      <div className="mt-[var(--sp-2)] flex items-center gap-2">
        <div className="min-w-0 flex-1 truncate font-mono text-[length:var(--text-sm)] font-semibold text-[var(--text-1)]">
          {value}
        </div>
        {tone ? <Badge variant={badgeVariantForTone(tone)}>{tone === "success" ? "Active" : "Interactive"}</Badge> : null}
      </div>
    </div>
  );
}

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
    <div className="rounded-lg border border-[var(--ide-border-subtle)] bg-[var(--surface-2)] p-[var(--sp-4)]">
      <div className="text-[length:var(--text-xs)] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">
        {phase}
      </div>
      <div className="mt-[var(--sp-2)] text-[length:var(--text-base)] font-semibold text-[var(--text-1)]">
        {title}
      </div>
      <div className="mt-[var(--sp-2)] text-[length:var(--text-sm)] leading-[var(--leading-relaxed)] text-[var(--text-soft)]">
        {description}
      </div>
    </div>
  );
}
