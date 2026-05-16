"use client";

import { useMemo } from "react";

import Sparkline from "@/components/ui/Sparkline";
import { useTransport } from "@/components/runs/control-room/context-hooks";

const MAX_SAMPLES = 60;

export default function ChartsDock() {
  const tp = useTransport();
  const rows = tp.scalarRows;
  const slice = rows.length > MAX_SAMPLES ? rows.slice(-MAX_SAMPLES) : rows;

  const eTotalData = useMemo(() => slice.map((r) => r.e_total), [slice]);
  const dmDtData = useMemo(
    () => slice.map((r) => Math.log10(Math.max(r.max_dm_dt, 1e-12)) + 12),
    [slice],
  );
  const mxData = useMemo(() => slice.map((r) => r.mx), [slice]);

  const count = rows.length;

  return (
    <div className="flex h-full flex-col bg-card/35 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border/15 bg-background/30 shrink-0">
        <span className="text-[0.62rem] font-bold uppercase tracking-[0.12em] text-muted-foreground/70">
          Scalar trends
        </span>
        <span className="ml-auto font-mono text-[0.62rem] text-muted-foreground/60">
          {count.toLocaleString()} samples
        </span>
      </div>
      <div className="flex flex-col gap-2 p-2 flex-1 overflow-hidden min-h-0">
        <div className="flex flex-col gap-0.5">
          <span className="text-[0.55rem] font-semibold uppercase tracking-wider text-muted-foreground/70">
            E_total
          </span>
          <Sparkline data={eTotalData} responsive height={22} color="#6366f1" fill />
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-[0.55rem] font-semibold uppercase tracking-wider text-muted-foreground/70">
            dm/dt (log)
          </span>
          <Sparkline data={dmDtData} responsive height={22} color="#10b981" fill />
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-[0.55rem] font-semibold uppercase tracking-wider text-muted-foreground/70">
            mx
          </span>
          <Sparkline data={mxData} responsive height={22} color="#0ea5e9" fill />
        </div>
      </div>
    </div>
  );
}

