"use client";

import { useMemo } from "react";

import { SIMULATION_SOLVER_ENERGIES_HISTORY_PATH } from "@/kernel/api/apiPaths";
import type { SolverEnergyHistoryResource } from "@/kernel/api/apiTypes";
import { useSolverEnergyHistoryResource } from "@/kernel/resources/studyRuntimeResources";
import type { ChartSeries } from "@/shared/domain/analysis/chartSeries";

export type LiveEnergyXAxisId = "step" | "t";

export interface LiveEnergyChartData {
  series: ChartSeries[];
  xAxisId: LiveEnergyXAxisId;
}

export function isLiveEnergyLoadEnabled({ active, descriptorId, paused }: { active: boolean; descriptorId: string; paused: boolean }): boolean {
  return active && descriptorId === "energy" && !paused;
}

export function useLiveEnergyData({ active, descriptorId, paused }: { active: boolean; descriptorId: string; paused: boolean }) {
  const enabled = isLiveEnergyLoadEnabled({ active, descriptorId, paused });
  const resource = useSolverEnergyHistoryResource(800, { enabled });
  const chart = useMemo(
    () => buildLiveEnergyChartData(resource.data, resource.status),
    [resource.data, resource.status],
  );
  return { resource, ...chart };
}

/**
 * Energy history already carries both accepted step and physical time. A
 * constant finite clock with increasing accepted steps is the available
 * resource-level signature of iterative relaxation, so use the published
 * step coordinate without requesting a separate solver-mode resource.
 */
export function buildLiveEnergyChartData(
  resource: Pick<SolverEnergyHistoryResource, "rows"> | null,
  status: ChartSeries["status"],
): LiveEnergyChartData {
  const xAxisId = resolveLiveEnergyXAxisId(resource?.rows ?? []);
  if (!resource?.rows.length) return { series: [], xAxisId };
  const xKey = xAxisId === "step" ? "step" : "time_seconds";
  const xUnit = xAxisId === "step" ? "1" : "s";

  const series = ["exchange", "demag", "zeeman", "anisotropy", "dmi", "total"] as const;
  const chartSeries = series.flatMap((id) => {
    const points = resource.rows.flatMap((row, rowIndex) => {
      const x = Number(row[xKey]);
      const y = Number(row[id]);
      return Number.isFinite(x) && Number.isFinite(y) ? [{ rowIndex, x, y }] : [];
    });
    return points.length ? [{
      id: `simulation.solver.energies:${id}`,
      label: `E ${id}`,
      points,
      quantity: id,
      source: { kind: "simulation.solver.energies.history" as const, resourceKey: SIMULATION_SOLVER_ENERGIES_HISTORY_PATH, tableId: "solver-energies" },
      status,
      unit: "J",
      xUnit,
    }] : [];
  });

  return { series: chartSeries, xAxisId };
}

export function resolveLiveEnergyXAxisId(
  rows: SolverEnergyHistoryResource["rows"],
): LiveEnergyXAxisId {
  if (rows.length < 2) return "t";

  const fixedTime = rows[0]?.time_seconds;
  if (typeof fixedTime !== "number" || !Number.isFinite(fixedTime)) return "t";

  let previousStep = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    if (
      typeof row.time_seconds !== "number" ||
      !Number.isFinite(row.time_seconds) ||
      row.time_seconds !== fixedTime ||
      !Number.isSafeInteger(row.step) ||
      row.step <= previousStep
    ) {
      return "t";
    }
    previousStep = row.step;
  }

  return "step";
}
