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

export default function RunsIndexPage() {
  const [sessions, setSessions] = useState<SessionManifest[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const response = await fetch(`${API_BASE}/v1/sessions`, { cache: "no-store" });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
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
    const id = window.setInterval(() => {
      void load();
    }, 2000);

    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const latest = useMemo(() => sessions[0] ?? null, [sessions]);

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Runs</h1>
        <p className="page-subtitle">
          Session-backed simulations and direct links to the live control room
        </p>
      </div>

      {latest && (
        <section style={{ marginBottom: "var(--sp-6)" }}>
          <div className="card">
            <div className="card-header">
              <div>
                <h2 className="card-title">Latest Session</h2>
                <p className="card-subtitle">Open the newest run directly</p>
              </div>
              <span className={`badge badge-${statusAccent(latest.status)}`}>
                <span className="badge-dot" />
                {latest.status}
              </span>
            </div>
            <div className="card-body">
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                  gap: "var(--sp-4)",
                  marginBottom: "var(--sp-4)",
                }}
              >
                <InfoLine label="Problem" value={latest.problem_name} />
                <InfoLine label="Backend" value={latest.requested_backend} />
                <InfoLine label="Mode" value={latest.execution_mode} />
                <InfoLine label="Precision" value={latest.precision} />
              </div>
              <Link href={`/runs/${latest.session_id}`} className="primary-link">
                Open latest control room
              </Link>
            </div>
          </div>
        </section>
      )}

      <section>
        <div className="card">
          <div className="card-header">
            <div>
              <h2 className="card-title">Recent Sessions</h2>
              <p className="card-subtitle">Every `fullmag script.py` execution lands here</p>
            </div>
          </div>
          <div className="card-body">
            {error && <p style={{ color: "var(--error)" }}>{error}</p>}
            {!error && sessions.length === 0 && (
              <div style={{ color: "var(--text-muted)", lineHeight: 1.8 }}>
                No sessions yet. Run:
                <div>
                  <code>fullmag examples/exchange_relax.py --until 2e-9</code>
                </div>
              </div>
            )}
            {sessions.length > 0 && (
              <div
                style={{
                  display: "grid",
                  gap: "var(--sp-3)",
                }}
              >
                {sessions.map((session) => (
                  <Link
                    key={session.session_id}
                    href={`/runs/${session.session_id}`}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "minmax(180px, 1.2fr) minmax(140px, 0.9fr) minmax(100px, 0.7fr) minmax(110px, 0.7fr) auto",
                      gap: "var(--sp-3)",
                      alignItems: "center",
                      padding: "var(--sp-3) var(--sp-4)",
                      borderRadius: "var(--radius-md)",
                      border: "1px solid var(--border)",
                      textDecoration: "none",
                      background: "var(--bg-raised)",
                      color: "inherit",
                    }}
                  >
                    <div>
                      <div style={{ color: "var(--text-primary)", fontWeight: 600 }}>
                        {session.problem_name}
                      </div>
                      <div style={{ color: "var(--text-muted)", fontSize: "var(--text-sm)" }}>
                        {session.session_id}
                      </div>
                    </div>
                    <span style={{ color: "var(--text-muted)" }}>{session.requested_backend}</span>
                    <span style={{ color: "var(--text-muted)" }}>{session.execution_mode}</span>
                    <span style={{ color: "var(--text-muted)" }}>{session.precision}</span>
                    <span className={`badge badge-${statusAccent(session.status)}`}>
                      <span className="badge-dot" />
                      {session.status}
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>
    </>
  );
}

function InfoLine({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="metric-label">{label}</div>
      <div style={{ color: "var(--text-primary)" }}>{value}</div>
    </div>
  );
}

function statusAccent(status: string): "success" | "error" | "warning" | "info" {
  if (status === "completed") {
    return "success";
  }
  if (status === "failed") {
    return "error";
  }
  if (status === "running") {
    return "warning";
  }
  return "info";
}
