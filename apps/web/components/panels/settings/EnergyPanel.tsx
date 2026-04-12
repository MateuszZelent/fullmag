"use client";

import { useMemo } from "react";
import { useTransport } from "../../runs/control-room/context-hooks";
import { fmtExpOrDash } from "../../runs/control-room/shared";
import { MetricField, buildSparkSeries, SidebarSection } from "./primitives";

export default function EnergyPanel() {
  const ctx = useTransport();
  const sparkSeries = useMemo(() => ({
    eEx: buildSparkSeries(
      ctx.scalarRows,
      (row) => row.e_ex,
      ctx.hasSolverTelemetry ? ctx.effectiveEEx : null,
    ),
    eDemag: buildSparkSeries(
      ctx.scalarRows,
      (row) => row.e_demag,
      ctx.hasSolverTelemetry ? ctx.effectiveEDemag : null,
    ),
    eExt: buildSparkSeries(
      ctx.scalarRows,
      (row) => row.e_ext,
      ctx.hasSolverTelemetry ? ctx.effectiveEExt : null,
    ),
    eAni: buildSparkSeries(
      ctx.scalarRows,
      (row) => row.e_ani,
      ctx.hasSolverTelemetry ? ctx.effectiveEAni : null,
    ),
    eDmi: buildSparkSeries(
      ctx.scalarRows,
      (row) => row.e_dmi,
      ctx.hasSolverTelemetry ? ctx.effectiveEDmi : null,
    ),
    eTotal: buildSparkSeries(
      ctx.scalarRows,
      (row) => row.e_total,
      ctx.hasSolverTelemetry ? ctx.effectiveETotal : null,
    ),
  }), [
    ctx.scalarRows,
    ctx.hasSolverTelemetry,
    ctx.effectiveEEx,
    ctx.effectiveEDemag,
    ctx.effectiveEExt,
    ctx.effectiveEAni,
    ctx.effectiveEDmi,
    ctx.effectiveETotal,
  ]);

  return (
    <div className="flex flex-col pt-4 px-2">
      <SidebarSection title="Energy Components" defaultOpen={true}>
        <div className="grid grid-cols-2 gap-3">
          <MetricField
            label="E_exchange"
            value={fmtExpOrDash(ctx.effectiveEEx, ctx.hasSolverTelemetry)}
            sparkData={sparkSeries.eEx}
            sparkColor="var(--chart-sky)"
          />
          <MetricField
            label="E_demag"
            value={fmtExpOrDash(ctx.effectiveEDemag, ctx.hasSolverTelemetry)}
            sparkData={sparkSeries.eDemag}
            sparkColor="var(--chart-amber)"
          />
          <MetricField
            label="E_ext"
            value={fmtExpOrDash(ctx.effectiveEExt, ctx.hasSolverTelemetry)}
            sparkData={sparkSeries.eExt}
            sparkColor="var(--chart-emerald)"
          />
          <MetricField
            label="E_ani"
            value={fmtExpOrDash(ctx.effectiveEAni, ctx.hasSolverTelemetry)}
            sparkData={sparkSeries.eAni}
            sparkColor="var(--chart-rose)"
          />
          <MetricField
            label="E_dmi"
            value={fmtExpOrDash(ctx.effectiveEDmi, ctx.hasSolverTelemetry)}
            sparkData={sparkSeries.eDmi}
            sparkColor="var(--chart-fuchsia)"
          />
          <MetricField
            label="E_total"
            value={fmtExpOrDash(ctx.effectiveETotal, ctx.hasSolverTelemetry)}
            sparkData={sparkSeries.eTotal}
            sparkColor="var(--chart-violet)"
          />
        </div>
      </SidebarSection>
    </div>
  );
}
