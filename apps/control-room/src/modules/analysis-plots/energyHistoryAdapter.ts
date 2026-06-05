import { SIMULATION_SOLVER_ENERGIES_HISTORY_PATH } from "@/kernel/api/apiPaths";
import type { SolverEnergyHistoryResource } from "@/kernel/api/apiTypes";
import type { ResourceStatus } from "@/kernel/resources/resourceTypes";

import type { ChartSeries } from "./chartTableModel";

const ENERGY_TERMS = Object.freeze([
  { id: "exchange", label: "E exchange" },
  { id: "demag", label: "E demag" },
  { id: "zeeman", label: "E zeeman" },
  { id: "anisotropy", label: "E anisotropy" },
  { id: "dmi", label: "E DMI" },
  { id: "total", label: "E total" },
] as const);

const ENERGY_HISTORY_TABLE_ID = "solver-energies";

export function buildSolverEnergyHistoryChartSeries(
  resource: SolverEnergyHistoryResource | null | undefined,
  status: ResourceStatus = "ready",
): ChartSeries[] {
  if (!resource || resource.rows.length === 0) return [];
  const source = {
    kind: "simulation.solver.energies.history" as const,
    resourceKey: SIMULATION_SOLVER_ENERGIES_HISTORY_PATH,
    tableId: ENERGY_HISTORY_TABLE_ID,
  };

  return ENERGY_TERMS.flatMap((term) => {
    const points = resource.rows.flatMap((row, rowIndex) => {
      const x = Number(row.time_seconds);
      const y = Number(row[term.id]);
      return Number.isFinite(x) && Number.isFinite(y)
        ? [{ rowIndex, x, y }]
        : [];
    });
    if (points.length === 0) return [];
    return [
      {
        id: `simulation.solver.energies:${term.id}`,
        label: term.label,
        points,
        quantity: term.id,
        source,
        status,
        unit: "J",
        xUnit: "s",
      },
    ];
  });
}
