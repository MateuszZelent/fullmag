import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { KernelApi } from "@/kernel/types";

import type { ChartSeries } from "../chartTableModel";
import { AnalysisEnergySurface } from "./AnalysisEnergySurface";

const series: ChartSeries[] = [{
  id: "e_total",
  label: "E total",
  points: [{ rowIndex: 0, x: 1e-9, y: 2e-18 }],
  quantity: "e_total",
  source: {
    kind: "simulation.solver.energies.history",
    resourceKey: "simulation/solver/energies/history",
    tableId: "energies",
  },
  status: "ready",
  unit: "J",
  xUnit: "s",
}];

describe("AnalysisEnergySurface", () => {
  it("uses the renderer display transform for energy legend values", () => {
    const html = renderToStaticMarkup(
      <AnalysisEnergySurface
        kernel={{} as KernelApi}
        onPointSelect={() => undefined}
        onSelectedSeriesIdsChange={() => undefined}
        selectedSeriesIds={["e_total"]}
        series={series}
        status="ready"
      />,
    );

    expect(html).toContain('aria-label="E total, unit pJ, latest 2.0000e-6');
  });

  it("renders an explicit empty selection instead of restoring all energy series", () => {
    const html = renderToStaticMarkup(
      <AnalysisEnergySurface
        kernel={{} as KernelApi}
        onPointSelect={() => undefined}
        onSelectedSeriesIdsChange={() => undefined}
        selectedSeriesIds={[]}
        series={series}
        status="ready"
      />,
    );

    expect(html).toContain("Select at least one signal");
  });
});
