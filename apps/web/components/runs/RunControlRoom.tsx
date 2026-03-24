"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import ScalarPlot from "../plots/ScalarPlot";
import MagnetizationSlice2D from "../preview/MagnetizationSlice2D";
import MagnetizationView3D from "../preview/MagnetizationView3D";

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
  plan_summary: unknown;
};

type RunManifest = {
  run_id: string;
  session_id: string;
  status: string;
  total_steps: number;
  final_time: number | null;
  final_e_ex: number | null;
  artifact_dir: string;
};

type ScalarRow = {
  step: number;
  time: number;
  solver_dt: number;
  e_ex: number;
};

type StepStats = {
  step: number;
  time: number;
  dt: number;
  e_ex: number;
  max_dm_dt: number;
  max_h_eff: number;
  wall_time_ns: number;
};

type LiveState = {
  status: string;
  updated_at_unix_ms: number;
  latest_step: StepStats & {
    grid: [number, number, number];
    magnetization?: number[];
    finished: boolean;
  };
};

type FieldSnapshot = {
  layout: {
    backend: string;
    grid_cells?: [number, number, number];
    cell_size?: [number, number, number];
  };
  observable: string;
  step: number;
  time: number;
  solver_dt: number;
  provenance: Record<string, unknown>;
  values: [number, number, number][];
};

type ArtifactEntry = {
  path: string;
  kind: string;
};

type SessionStateResponse = {
  session: SessionManifest;
  run?: RunManifest | null;
  live_state?: LiveState | null;
  metadata?: Record<string, unknown> | null;
  scalar_rows: ScalarRow[];
  latest_fields: {
    m?: FieldSnapshot | null;
    h_ex?: FieldSnapshot | null;
  };
  artifacts: ArtifactEntry[];
};

export default function RunControlRoom({ sessionId }: { sessionId: string }) {
  const [state, setState] = useState<SessionStateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchState = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/v1/sessions/${sessionId}/state`, {
        cache: "no-store",
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || `HTTP ${response.status}`);
      }
      const payload = (await response.json()) as SessionStateResponse;
      setState(payload);
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  }, [sessionId]);

  useEffect(() => {
    void fetchState();
  }, [fetchState]);

  useEffect(() => {
    const id = window.setInterval(() => {
      void fetchState();
    }, 1500);
    return () => window.clearInterval(id);
  }, [fetchState]);

  const chartSteps = useMemo<StepStats[]>(() => {
    if (!state) {
      return [];
    }
    if (state.scalar_rows.length > 0) {
      return state.scalar_rows.map((row) => ({
        step: row.step,
        time: row.time,
        dt: row.solver_dt,
        e_ex: row.e_ex,
        max_dm_dt: 0,
        max_h_eff: 0,
        wall_time_ns: 0,
      }));
    }
    if (state.live_state) {
      return [state.live_state.latest_step];
    }
    return [];
  }, [state]);

  const latestField = state?.latest_fields.m ?? null;
  const liveMagnetization = state?.live_state?.latest_step.magnetization;
  const grid =
    state?.live_state?.latest_step.grid ??
    latestField?.layout.grid_cells ??
    ([0, 0, 0] as [number, number, number]);
  const magnetization = useMemo(() => {
    if (liveMagnetization && liveMagnetization.length > 0) {
      return new Float64Array(liveMagnetization);
    }
    if (latestField?.values) {
      return new Float64Array(latestField.values.flat());
    }
    return null;
  }, [latestField, liveMagnetization]);

  const status = state?.session.status ?? "loading";
  const lastStep =
    state?.live_state?.latest_step ??
    (chartSteps.length > 0 ? chartSteps[chartSteps.length - 1] : null);
  const provenance = latestField?.provenance ?? state?.metadata?.execution_provenance ?? null;

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Run {sessionId}</h1>
        <p className="page-subtitle">
          Session-backed exchange-only control room for the current bootstrap shell
        </p>
      </div>

      <div className="metric-grid">
        <MetricCard label="Status" value={status} accent={statusAccent(status)} />
        <MetricCard
          label="Backend"
          value={state?.session.requested_backend ?? "—"}
          accent="info"
        />
        <MetricCard
          label="Mode"
          value={state?.session.execution_mode ?? "—"}
          accent="info"
        />
        <MetricCard
          label="Precision"
          value={state?.session.precision ?? "—"}
          accent="success"
        />
      </div>

      <section style={{ marginTop: "var(--sp-6)" }}>
        <div className="card">
          <div className="card-header">
            <div>
              <h2 className="card-title">Run Summary</h2>
              <p className="card-subtitle">
                Live session status plus the latest scalar diagnostics
              </p>
            </div>
          </div>
          <div className="card-body">
            {error && (
              <p style={{ color: "var(--error)", marginBottom: "var(--sp-3)" }}>{error}</p>
            )}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                gap: "var(--sp-4)",
              }}
            >
              <InfoLine label="Problem" value={state?.session.problem_name ?? "—"} />
              <InfoLine label="Script" value={state?.session.script_path ?? "—"} />
              <InfoLine
                label="Total steps"
                value={String(state?.run?.total_steps ?? lastStep?.step ?? 0)}
              />
              <InfoLine
                label="Latest time"
                value={lastStep ? `${lastStep.time.toExponential(4)} s` : "—"}
              />
              <InfoLine
                label="Latest E_ex"
                value={lastStep ? `${lastStep.e_ex.toExponential(4)} J` : "—"}
              />
              <InfoLine
                label="Artifacts"
                value={String(state?.artifacts.length ?? 0)}
              />
            </div>
          </div>
        </div>
      </section>

      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
          gap: "var(--sp-6)",
          marginTop: "var(--sp-6)",
        }}
      >
        <div className="card">
          <div className="card-header">
            <div>
              <h2 className="card-title">2D Slice</h2>
              <p className="card-subtitle">In-plane magnetization preview</p>
            </div>
          </div>
          <div className="card-body">
            {magnetization ? (
              <MagnetizationSlice2D grid={grid} magnetization={magnetization} />
            ) : (
              <EmptyPanel message="Waiting for the first magnetization snapshot..." />
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <div>
              <h2 className="card-title">3D Magnetization</h2>
              <p className="card-subtitle">FDM grid preview of the latest m field</p>
            </div>
          </div>
          <div className="card-body">
            {magnetization ? (
              <MagnetizationView3D grid={grid} magnetization={magnetization} />
            ) : (
              <EmptyPanel message="Waiting for the first magnetization snapshot..." />
            )}
          </div>
        </div>
      </section>

      <section style={{ marginTop: "var(--sp-6)" }}>
        <div className="card">
          <div className="card-header">
            <div>
              <h2 className="card-title">Scalars</h2>
              <p className="card-subtitle">Exchange energy history from live or finalized artifacts</p>
            </div>
          </div>
          <div className="card-body">
            {chartSteps.length > 0 ? (
              <ScalarPlot steps={chartSteps} yField="e_ex" />
            ) : (
              <EmptyPanel message="Scalar history will appear as soon as the run publishes data." />
            )}
          </div>
        </div>
      </section>

      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
          gap: "var(--sp-6)",
          marginTop: "var(--sp-6)",
        }}
      >
        <div className="card">
          <div className="card-header">
            <div>
              <h2 className="card-title">Artifacts</h2>
              <p className="card-subtitle">Files currently visible for this session</p>
            </div>
          </div>
          <div className="card-body">
            {state?.artifacts.length ? (
              <ul
                style={{
                  margin: 0,
                  paddingLeft: "1.1rem",
                  display: "grid",
                  gap: "var(--sp-2)",
                  color: "var(--text-muted)",
                }}
              >
                {state.artifacts.map((artifact) => (
                  <li key={artifact.path}>
                    <code>{artifact.path}</code> <span>({artifact.kind})</span>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyPanel message="Artifacts will appear after the first files are materialized." />
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <div>
              <h2 className="card-title">Provenance</h2>
              <p className="card-subtitle">Execution metadata for reproducibility</p>
            </div>
          </div>
          <div className="card-body">
            <pre
              style={{
                margin: 0,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                fontSize: "var(--text-sm)",
                color: "var(--text-muted)",
                fontFamily: "var(--font-mono)",
              }}
            >
              {JSON.stringify(provenance ?? state?.metadata ?? {}, null, 2)}
            </pre>
          </div>
        </div>
      </section>
    </>
  );
}

function EmptyPanel({ message }: { message: string }) {
  return <p style={{ color: "var(--text-muted)", margin: 0 }}>{message}</p>;
}

function InfoLine({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="metric-label">{label}</div>
      <div style={{ color: "var(--text-primary)", fontSize: "var(--text-sm)" }}>{value}</div>
    </div>
  );
}

function MetricCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: "success" | "error" | "warning" | "info";
}) {
  const accentColor = accent ? `var(--${accent})` : "var(--text-primary)";
  return (
    <div className="card metric-card">
      <div className="metric-label">{label}</div>
      <div className="metric-value" style={{ color: accentColor }}>
        {value}
      </div>
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
