import { describe, expect, it } from "vitest";

import { buildSolverEnergyHistoryChartSeries } from "../energyHistoryAdapter";
import type { SolverEnergyHistoryResource } from "@/kernel/api/apiTypes";

describe("useAnalysisEnergyData adapter", () => {
  it("builds energy history chart series from solver energy payload", () => {
    const resource: SolverEnergyHistoryResource = {
      returned_rows: 2,
      revision: 1,
      total_rows: 2,
      rows: [
        {
          anisotropy: 0,
          demag: 1e-19,
          dmi: 0,
          exchange: 2e-19,
          step: 0,
          time_seconds: 0,
          total: 3e-19,
          zeeman: 0,
        },
        {
          anisotropy: 0,
          demag: 1e-19,
          dmi: 0,
          exchange: 2e-19,
          step: 1,
          time_seconds: 1e-9,
          total: 3e-19,
          zeeman: 0,
        },
      ],
    };

    const series = buildSolverEnergyHistoryChartSeries(resource, "ready");

    expect(series.map((entry) => ({
      dataRevision: entry.dataRevision ?? null,
      id: entry.id,
      points: entry.points,
      source: entry.source,
      status: entry.status,
      unit: entry.unit,
      xUnit: entry.xUnit,
    }))).toEqual([
      { dataRevision: null, id: "simulation.solver.energies:exchange", points: [{ rowIndex: 0, x: 0, y: 2e-19 }, { rowIndex: 1, x: 1e-9, y: 2e-19 }], source: { kind: "simulation.solver.energies.history", resourceKey: "/v2/sessions/current/simulation/solver/energies/history", tableId: "solver-energies" }, status: "ready", unit: "J", xUnit: "s" },
      { dataRevision: null, id: "simulation.solver.energies:demag", points: [{ rowIndex: 0, x: 0, y: 1e-19 }, { rowIndex: 1, x: 1e-9, y: 1e-19 }], source: { kind: "simulation.solver.energies.history", resourceKey: "/v2/sessions/current/simulation/solver/energies/history", tableId: "solver-energies" }, status: "ready", unit: "J", xUnit: "s" },
      { dataRevision: null, id: "simulation.solver.energies:zeeman", points: [{ rowIndex: 0, x: 0, y: 0 }, { rowIndex: 1, x: 1e-9, y: 0 }], source: { kind: "simulation.solver.energies.history", resourceKey: "/v2/sessions/current/simulation/solver/energies/history", tableId: "solver-energies" }, status: "ready", unit: "J", xUnit: "s" },
      { dataRevision: null, id: "simulation.solver.energies:anisotropy", points: [{ rowIndex: 0, x: 0, y: 0 }, { rowIndex: 1, x: 1e-9, y: 0 }], source: { kind: "simulation.solver.energies.history", resourceKey: "/v2/sessions/current/simulation/solver/energies/history", tableId: "solver-energies" }, status: "ready", unit: "J", xUnit: "s" },
      { dataRevision: null, id: "simulation.solver.energies:dmi", points: [{ rowIndex: 0, x: 0, y: 0 }, { rowIndex: 1, x: 1e-9, y: 0 }], source: { kind: "simulation.solver.energies.history", resourceKey: "/v2/sessions/current/simulation/solver/energies/history", tableId: "solver-energies" }, status: "ready", unit: "J", xUnit: "s" },
      { dataRevision: null, id: "simulation.solver.energies:total", points: [{ rowIndex: 0, x: 0, y: 3e-19 }, { rowIndex: 1, x: 1e-9, y: 3e-19 }], source: { kind: "simulation.solver.energies.history", resourceKey: "/v2/sessions/current/simulation/solver/energies/history", tableId: "solver-energies" }, status: "ready", unit: "J", xUnit: "s" },
    ]);
  });
});
