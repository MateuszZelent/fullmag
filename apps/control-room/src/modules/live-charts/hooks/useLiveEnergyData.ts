"use client";

import { useMemo } from "react";

import { useSolverEnergyHistoryResource } from "@/kernel/resources/studyRuntimeResources";
import type { ChartSeries } from "@/shared/domain/analysis/chartSeries";
import { SIMULATION_SOLVER_ENERGIES_HISTORY_PATH } from "@/kernel/api/apiPaths";

export function isLiveEnergyLoadEnabled({ active, descriptorId, paused }: { active: boolean; descriptorId: string; paused: boolean }): boolean {
  return active && descriptorId === "energy" && !paused;
}

export function useLiveEnergyData({ active, descriptorId, paused }: { active: boolean; descriptorId: string; paused: boolean }) {
  const enabled = isLiveEnergyLoadEnabled({ active, descriptorId, paused });
  const resource = useSolverEnergyHistoryResource(800, { enabled });
  const series = useMemo<ChartSeries[]>(() => liveEnergySeries(resource.data, resource.status), [resource.data, resource.status]);
  return { resource, series };
}

function liveEnergySeries(resource: { rows: readonly Record<string, unknown>[] } | null, status: string): ChartSeries[] {
  if (!resource?.rows.length) return [];
  return ["exchange", "demag", "zeeman", "anisotropy", "dmi", "total"].flatMap((id) => {
    const points = resource.rows.flatMap((row, rowIndex) => {
      const x = Number(row.time_seconds);
      const y = Number(row[id]);
      return Number.isFinite(x) && Number.isFinite(y) ? [{ rowIndex, x, y }] : [];
    });
    return points.length ? [{
      id: `simulation.solver.energies:${id}`,
      label: `E ${id}`,
      points,
      quantity: id,
      source: { kind: "simulation.solver.energies.history" as const, resourceKey: SIMULATION_SOLVER_ENERGIES_HISTORY_PATH, tableId: "solver-energies" },
      status: status as ChartSeries["status"],
      unit: "J",
      xUnit: "s",
    }] : [];
  });
}
