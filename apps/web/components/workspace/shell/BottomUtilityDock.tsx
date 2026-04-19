"use client";


import { cn } from "@/lib/utils";
import { fmtTime, fmtDuration, fmtStepValue, fmtSIOrDash, fmtExpOrDash } from "@/lib/format";
import type { ActivityInfo } from "@/components/runs/control-room/types";

interface BottomTelemetryDockProps {
  activity: ActivityInfo | null;
  workspaceStatus: string;
  effectiveStep: number;
  effectiveTime: number;
  effectiveDt: number;
  effectiveDmDt: number;
  effectiveTorqueT: number;
  effectiveHEff: number;
  stepsPerSec: number;
  elapsed: number;
  hasSolverTelemetry: boolean;
  eTotal: number;
  /** Activity detail or solver stage label */
  activityDetail: string | null;
  solverIntegrator?: string | null;
  solverMaxError?: number | null;
  solverMinDt?: number | null;
  solverMaxDt?: number | null;
  solverFixedDt?: number | null;
}

function fmtTimeOrDash(v: number, enabled: boolean): string {
  return enabled ? fmtTime(v) : "—";
}

function fmtSolverIntegrator(v: string | null | undefined): string {
  if (!v) return "—";
  const normalized = v.trim().toLowerCase();
  if (!normalized) return "—";
  const alias: Record<string, string> = {
    heun: "Heun (RK2)",
    rk4: "RK4",
    rk23: "RK23",
    rk45: "RK45",
    abm3: "ABM3",
  };
  return alias[normalized] ?? v;
}

export default function BottomTelemetryDock({
  activity,
  workspaceStatus,
  effectiveStep,
  effectiveTime,
  effectiveDt,
  effectiveDmDt,
  effectiveTorqueT,
  effectiveHEff,
  stepsPerSec,
  elapsed,
  hasSolverTelemetry,
  eTotal,
  activityDetail,
  solverIntegrator,
  solverMaxError,
  solverMinDt,
  solverMaxDt,
  solverFixedDt,
}: BottomTelemetryDockProps) {
  const statusClassName =
    workspaceStatus === "completed"
      ? "text-[--chart-emerald]"
      : workspaceStatus === "running"
        ? "text-primary"
        : workspaceStatus === "materializing_script"
          ? "text-[--chart-amber]"
          : workspaceStatus === "failed"
            ? "text-destructive"
            : undefined;

  const activityLabel = activity?.label ?? null;

  const telemetryCards: Array<{
    label: string;
    hint: string;
    accent: string;
    value: string;
    valueClassName?: string;
  }> = [
    {
      label: "Step",
      hint: "Aktualny krok integratora (licznik iteracji solvera).",
      accent: "border-l-[--chart-sky]",
      value: fmtStepValue(effectiveStep, hasSolverTelemetry),
    },
    {
      label: "Simulation time",
      hint: "Czas fizyczny symulacji (nie czas ścienny).",
      accent: "border-l-[--chart-violet]",
      value: fmtTimeOrDash(effectiveTime, hasSolverTelemetry),
    },
    {
      label: "Time step (Δt)",
      hint: "Bieżący krok czasowy używany przez solver.",
      accent: "border-l-[--chart-amber]",
      value: fmtSIOrDash(effectiveDt, "s", hasSolverTelemetry),
    },
    {
      label: "minDt",
      hint: "Najmniejszy obserwowany krok dt albo limit z planu adaptacyjnego.",
      accent: "border-l-[--chart-orange]",
      value: fmtSIOrDash(solverMinDt ?? 0, "s", Boolean(solverMinDt != null && hasSolverTelemetry)),
    },
    {
      label: "maxDt",
      hint: "Największy obserwowany krok dt albo limit z planu adaptacyjnego.",
      accent: "border-l-[--chart-orange]",
      value: fmtSIOrDash(solverMaxDt ?? 0, "s", Boolean(solverMaxDt != null && hasSolverTelemetry)),
    },
    {
      label: "Fixed Δt",
      hint: "Sztywny krok czasowy ustawiony w planie/ustawieniach solvera.",
      accent: "border-l-[--chart-violet]",
      value: fmtSIOrDash(solverFixedDt ?? 0, "s", solverFixedDt != null),
    },
    {
      label: "Solver",
      hint: "Aktualny integrator czasowy (np. Heun, RK23, RK45).",
      accent: "border-l-[--chart-violet]",
      value: fmtSolverIntegrator(solverIntegrator),
    },
    {
      label: "Max error",
      hint: "Adaptacyjna tolerancja błędu (atol) dla RK23/RK45.",
      accent: "border-l-[--chart-amber]",
      value: fmtExpOrDash(solverMaxError ?? 0, solverMaxError != null),
    },
    {
      label: "max dm/dt",
      hint: "Miara zbieżności: mniejsze wartości oznaczają stabilizację rozwiązania.",
      accent: "border-l-[--chart-emerald]",
      value: fmtExpOrDash(effectiveDmDt, hasSolverTelemetry),
    },
    {
      label: "max torque",
      hint: "Maksymalna wartość momentu magnetycznego [T].",
      accent: "border-l-[--chart-cyan]",
      value: fmtExpOrDash(effectiveTorqueT, hasSolverTelemetry),
    },
    {
      label: "max |H_eff|",
      hint: "Maksymalna wartość efektywnego pola magnetycznego.",
      accent: "border-l-[--chart-rose]",
      value: fmtExpOrDash(effectiveHEff, hasSolverTelemetry),
    },
    {
      label: "E_total",
      hint: "Całkowita energia układu.",
      accent: "border-l-[--chart-indigo]",
      value: fmtSIOrDash(eTotal, "J", hasSolverTelemetry),
    },
    {
      label: "Elapsed wall time",
      hint: "Czas rzeczywisty (wall clock) od startu obliczeń.",
      accent: "border-l-[--chart-slate]",
      value: fmtDuration(elapsed),
    },
    {
      label: "Throughput",
      hint: "Wydajność solvera: liczba kroków na sekundę.",
      accent: "border-l-[--chart-orange]",
      value: stepsPerSec > 0 ? `${stepsPerSec.toFixed(1)} steps/s` : "—",
    },
  ];

  return (
    <div className="flex h-full flex-col bg-card/35 isolate overflow-hidden relative z-40 border-t border-border/30">
      {/* ── Header ── */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border/15 bg-background/30">
        <span className="text-[0.62rem] font-bold uppercase tracking-[0.12em] text-muted-foreground/70">
          Telemetry
        </span>
        <span
          className={cn(
            "ml-1 text-[0.62rem] font-semibold uppercase tracking-wide",
            statusClassName ?? "text-muted-foreground",
          )}
        >
          {workspaceStatus}
        </span>
        {activityDetail && (
          <>
            <div className="h-3 w-px bg-border/30" />
            <span className="text-[0.6rem] text-muted-foreground/60 truncate max-w-[300px]">
              {activityDetail}
            </span>
          </>
        )}
      </div>

      {/* ── Telemetry grid ── */}
      <div className="flex-1 overflow-hidden">
        <div className="border-b border-border/15 px-3 py-1 text-[0.58rem] text-muted-foreground/75">
          Live solver telemetry • hover kafelek aby zobaczyć co oznacza dana metryka.
          {activityLabel ? ` • aktywność: ${activityLabel}` : ""}
        </div>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-1.5 p-2">
          {telemetryCards.map((card) => (
            <div
              key={card.label}
              title={card.hint}
              className={cn(
                "flex flex-col gap-0.5 rounded-md border-l-[3px] bg-card/20 p-2 shadow-sm",
                card.accent,
              )}
            >
              <span className="text-[0.58rem] font-semibold uppercase tracking-wider text-muted-foreground">
                {card.label}
              </span>
              <span className={cn("font-mono text-[0.78rem] font-semibold text-foreground", card.valueClassName)}>
                {card.value}
              </span>
            </div>
          ))}

        </div>
      </div>
    </div>
  );
}
