"use client";

import { useMemo } from "react";

import ScalarPlot from "@/components/plots/ScalarPlot";
import EmptyState from "@/components/ui/EmptyState";
import { useCommand, useTransport } from "./ControlRoomContext";

const PREFERRED_COLUMNS = ["e_total", "max_dm_dt", "solver_dt", "max_h_eff"] as const;

export default function ChartsViewport() {
  const cmd = useCommand();
  const tp = useTransport();

  const yColumns = useMemo(() => {
    if (tp.scalarRows.length === 0) {
      return [...PREFERRED_COLUMNS];
    }
    const sample = tp.scalarRows[tp.scalarRows.length - 1] as unknown as Record<string, unknown>;
    const available = PREFERRED_COLUMNS.filter((key) => typeof sample[key] === "number");
    return available.length > 0 ? available : [...PREFERRED_COLUMNS];
  }, [tp.scalarRows]);

  if (tp.scalarRows.length < 2) {
    return (
      <div className="flex h-full items-center justify-center">
        <EmptyState
          title="Charts waiting for telemetry"
          description="Run or resume the solver to stream scalar samples into the chart workspace."
          tone="info"
          compact
        />
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 min-w-0 bg-background">
      <ScalarPlot rows={tp.scalarRows} quantities={cmd.quantities} xColumn="time" yColumns={yColumns} />
    </div>
  );
}
