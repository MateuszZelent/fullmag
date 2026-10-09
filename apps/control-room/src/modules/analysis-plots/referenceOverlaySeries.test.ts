import { describe, expect, it } from "vitest";

import { importedReferenceDefinition } from "@/kernel/analysis-modules/postprocessingDefinitions";
import type { ChartSeries } from "@/shared/domain/analysis/chartSeries";

import { referenceOverlaySeries } from "./referenceOverlaySeries";

const computed = [{
  id: "analysis.frequency-domain:eigen:dispersion:b1",
  label: "Branch 1",
  points: [{ rowIndex: 0, x: 0, y: 9.3 }],
  quantity: "frequency",
  source: { resourceKey: "dispersion", tableId: "dispersion" },
  status: "ready",
  unit: "GHz",
  xUnit: "rad/m",
}] as unknown as ChartSeries[];

const reference = importedReferenceDefinition({
  dataset: { artifactRevision: 7, runId: "run-1", stageId: "eigen" },
  fileName: "comsol.txt",
  label: "COMSOL sweep",
  points: [[-25e6, 13.68e9], [0, 9.32e9]],
  sourceUnits: { frequency: "GHz", path: "rad/um" },
});

describe("reference overlay series", () => {
  it("draws imported references of the shown run in the computed unit", () => {
    const [series] = referenceOverlaySeries(computed, [reference], { runId: "run-1", stageId: "eigen" });
    expect(series).toMatchObject({ label: "COMSOL sweep (reference)", quantity: "reference_frequency", unit: "GHz" });
    expect(series?.points.map((point) => [point.x, point.y])).toEqual([[-25e6, 13.68], [0, 9.32]]);
  });

  it("ignores references of another run or stage", () => {
    expect(referenceOverlaySeries(computed, [reference], { runId: "run-2", stageId: "eigen" })).toEqual([]);
    expect(referenceOverlaySeries(computed, [reference], { runId: "run-1", stageId: "other" })).toEqual([]);
  });
});
