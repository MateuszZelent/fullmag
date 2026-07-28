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

    expect(series.length).toBeGreaterThan(0);
    expect(series[0].id).toContain("simulation.solver.energies");
  });
});
