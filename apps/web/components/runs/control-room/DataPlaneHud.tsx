"use client";

import { memo, useMemo } from "react";
import { FRONTEND_DIAGNOSTIC_FLAGS } from "@/lib/debug/frontendDiagnosticFlags";
import { useSessionRuntimeStore } from "@/features/session-runtime/store/useSessionRuntimeStore";
import { cn } from "@/lib/utils";

/**
 * Dev-only HUD overlay showing live data-plane diagnostics:
 * session/run identity, solver step, FEM mesh generation, field revision,
 * staleness, and cache status.
 *
 * Gated behind `FRONTEND_DIAGNOSTIC_FLAGS.viewportChrome.showDataPlaneHud`.
 */
export const DataPlaneHud = memo(function DataPlaneHud() {
  const hidden =
    process.env.NODE_ENV === "production" ||
    !FRONTEND_DIAGNOSTIC_FLAGS.viewportChrome.showDataPlaneHud;

  const session = useSessionRuntimeStore((s) => s.session);
  const run = useSessionRuntimeStore((s) => s.run);
  const liveState = useSessionRuntimeStore((s) => s.liveState);
  const femMesh = useSessionRuntimeStore((s) => s.femMesh);
  const stepUpdateV2 = useSessionRuntimeStore((s) => s.stepUpdateV2);
  const connection = useSessionRuntimeStore((s) => s.connection);
  const isFemBackend = useSessionRuntimeStore((s) => s.isFemBackend);
  const bootstrapTs = useSessionRuntimeStore((s) => s.bootstrapTimestamp);
  const lastUpdateTs = useSessionRuntimeStore((s) => s.lastUpdateTimestamp);

  const rows = useMemo(() => {
    const r: Array<[string, string]> = [];

    r.push(["connection", connection]);
    r.push(["backend", isFemBackend ? "FEM" : "FDM"]);

    if (session) {
      r.push(["session", truncId(session.session_id)]);
    }
    if (run) {
      r.push(["run", truncId(run.run_id)]);
    }

    // Solver step / time
    const step = stepUpdateV2?.diagnostics?.step ?? liveState?.step;
    const time = stepUpdateV2?.diagnostics?.time ?? liveState?.time;
    const dt = stepUpdateV2?.diagnostics?.dt ?? liveState?.dt;
    if (step != null) r.push(["step", String(step)]);
    if (time != null) r.push(["time", fmtSci(time)]);
    if (dt != null) r.push(["dt", fmtSci(dt)]);

    // FEM mesh generation
    if (isFemBackend && femMesh) {
      const genId = femMesh.generation_id ?? femMesh.mesh_id ?? null;
      if (genId != null) r.push(["mesh gen", truncId(String(genId))]);
      r.push(["nodes", fmtInt(femMesh.nodes.length)]);
      r.push(["elements", fmtInt(femMesh.elements.length)]);
    }

    // FDM grid
    if (!isFemBackend && liveState?.grid) {
      r.push(["grid", liveState.grid.join(" × ")]);
    }

    // StepUpdateV2 diagnostics
    if (stepUpdateV2?.diagnostics) {
      const d = stepUpdateV2.diagnostics;
      if (d.error_estimate != null) r.push(["err est", fmtSci(d.error_estimate)]);
      if (d.rejected_attempts != null && d.rejected_attempts > 0)
        r.push(["rejected", String(d.rejected_attempts)]);
      if (d.rhs_evals != null) r.push(["rhs evals", String(d.rhs_evals)]);
    }

    // Finished?
    const finished = stepUpdateV2?.finished ?? liveState?.finished;
    if (finished != null) r.push(["finished", finished ? "yes" : "no"]);

    // Timestamps
    if (bootstrapTs) r.push(["bootstrap", fmtAgo(bootstrapTs)]);
    if (lastUpdateTs) r.push(["last update", fmtAgo(lastUpdateTs)]);

    return r;
  }, [
    connection,
    isFemBackend,
    session,
    run,
    liveState,
    femMesh,
    stepUpdateV2,
    bootstrapTs,
    lastUpdateTs,
  ]);

  if (hidden) {
    return null;
  }

  return (
    <div className="pointer-events-none absolute left-3 top-3 z-20">
      <div
        className={cn(
          "min-w-[16rem] rounded-xl border border-border/40 bg-background/78 px-3 py-2",
          "font-mono text-[0.65rem] text-foreground shadow-xl backdrop-blur-md",
        )}
      >
        <div className="mb-2 font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          Data Plane
        </div>
        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          {rows.map(([label, value]) => (
            <Row key={label} label={label} value={value} />
          ))}
        </div>
      </div>
    </div>
  );
});

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <span className="text-muted-foreground">{label}</span>
      <span className="truncate">{value}</span>
    </>
  );
}

function truncId(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 8)}…`;
}

function fmtSci(v: number): string {
  if (!Number.isFinite(v)) return "n/a";
  if (Math.abs(v) < 1e-3 || Math.abs(v) >= 1e6) return v.toExponential(3);
  return v.toPrecision(4);
}

function fmtInt(v: number): string {
  if (!Number.isFinite(v)) return "0";
  return Math.round(v).toLocaleString();
}

function fmtAgo(ts: number): string {
  const ago = Date.now() - ts;
  if (ago < 1000) return "just now";
  if (ago < 60_000) return `${Math.floor(ago / 1000)}s ago`;
  return `${Math.floor(ago / 60_000)}m ago`;
}
