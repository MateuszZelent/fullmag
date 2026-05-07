"use client";

import { useEffect, useMemo, useState } from "react";

import { cn } from "@/lib/utils";
import { fmtTime, fmtDuration, fmtStepValue, fmtSIOrDash, fmtExpOrDash } from "@/lib/format";
import type { ActivityInfo } from "@/components/runs/control-room/types";
import { useViewport } from "@/components/runs/control-room/context-hooks";
import { useSessionRuntimeStore } from "@/features/session-runtime/store/useSessionRuntimeStore";
import type { CapabilityMap } from "@/src/api/types";
import { isFemDiscretization, resolveFemDiscretization } from "@/src/domain/capabilities";
import { useViewportTelemetrySnapshot, type ViewportTelemetryEntry } from "@/lib/debug/viewportTelemetry";

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

function formatAgeLabel(ageMs: number | null): string {
  if (ageMs == null) {
    return "waiting";
  }
  if (ageMs < 1000) {
    return `${Math.round(ageMs)} ms`;
  }
  if (ageMs < 10_000) {
    return `${(ageMs / 1000).toFixed(1)} s`;
  }
  return `${Math.round(ageMs / 1000)} s`;
}

function ageTone(ageMs: number | null): "ok" | "warn" | "error" {
  if (ageMs == null) {
    return "warn";
  }
  if (ageMs < 1500) {
    return "ok";
  }
  if (ageMs < 5000) {
    return "warn";
  }
  return "error";
}

function ageValueClassName(tone: "ok" | "warn" | "error"): string {
  switch (tone) {
    case "ok":
      return "text-emerald-300";
    case "warn":
      return "text-amber-300";
    case "error":
      return "text-rose-300";
  }
}

function telemetryAccentClassName(tone: "ok" | "warn" | "error"): string {
  switch (tone) {
    case "ok":
      return "border-l-[--chart-emerald]";
    case "warn":
      return "border-l-[--chart-amber]";
    case "error":
      return "border-l-[--chart-rose]";
  }
}

function selectPrimary3dViewportEntry(
  entries: ViewportTelemetryEntry[],
  domainCapabilities: CapabilityMap | null,
): ViewportTelemetryEntry | null {
  const preferFemViewport = resolveFemDiscretization(domainCapabilities, false);
  const matching = entries.filter((entry) => {
    if (entry.renderer !== "webgl") {
      return false;
    }
    if (entry.label === "bounds-preview") {
      return false;
    }
    return preferFemViewport ? entry.label.startsWith("fem-") : entry.label === "fdm-viewport";
  });
  if (matching.length === 0) {
    return null;
  }
  const visible = matching.filter((entry) => !entry.hidden);
  const pool = visible.length > 0 ? visible : matching;
  return pool.reduce<ViewportTelemetryEntry | null>((latest, entry) => {
    if (!latest) {
      return entry;
    }
    return entry.lastFrameAtUnixMs >= latest.lastFrameAtUnixMs ? entry : latest;
  }, null);
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
  const viewport = useViewport();
  const connection = useSessionRuntimeStore((state) => state.connection);
  const domainCapabilities = useSessionRuntimeStore((state) => state.domainCapabilities);
  const lastUpdateTimestamp = useSessionRuntimeStore((state) => state.lastUpdateTimestamp);
  const viewportEntries = useViewportTelemetrySnapshot();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 200);
    return () => window.clearInterval(timer);
  }, []);

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
  const backendAgeMs = useMemo(
    () => (lastUpdateTimestamp != null ? Math.max(0, now - lastUpdateTimestamp) : null),
    [lastUpdateTimestamp, now],
  );
  const primary3dViewportEntry = useMemo(
    () => selectPrimary3dViewportEntry(viewportEntries, domainCapabilities),
    [domainCapabilities, viewportEntries],
  );
  const viewportAgeMs = useMemo(() => {
    const timestamp = primary3dViewportEntry?.lastFrameAtUnixMs;
    return timestamp != null && timestamp > 0 ? Math.max(0, now - timestamp) : null;
  }, [now, primary3dViewportEntry?.lastFrameAtUnixMs]);
  // During idle states the backend intentionally stops sending updates — suppress false warnings.
  const isIdleWorkspaceState =
    workspaceStatus === "waiting_for_compute" || workspaceStatus === "materializing_script";
  const backendAgeClassName = ageValueClassName(
    isIdleWorkspaceState ? "ok" : ageTone(backendAgeMs),
  );
  const viewportAgeClassName = ageValueClassName(
    isIdleWorkspaceState ? "ok" : ageTone(viewportAgeMs),
  );

  const telemetryCards: Array<{
    label: string;
    hint: string;
    accent: string;
    value: string;
    valueClassName?: string;
  }> = [
    {
      label: "Backend → FE",
      hint:
        connection === "connected"
          ? "Czas od ostatniego napływu danych z backendu do frontendu."
          : "Backend nie jest obecnie w pełni połączony z frontendem.",
      accent: telemetryAccentClassName(isIdleWorkspaceState ? "ok" : ageTone(backendAgeMs)),
      value: formatAgeLabel(backendAgeMs),
      valueClassName: backendAgeClassName,
    },
    {
      label: "3D render age",
      hint:
        viewport.effectiveViewMode === "3D"
          ? "Czas od ostatniego realnego frame/renderu głównego viewportu 3D."
          : "Czas od ostatniego renderu viewportu 3D; gdy 3D nie jest aktywne, licznik naturalnie rośnie.",
      accent: telemetryAccentClassName(isIdleWorkspaceState ? "ok" : ageTone(viewportAgeMs)),
      value: formatAgeLabel(viewportAgeMs),
      valueClassName: viewportAgeClassName,
    },
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
