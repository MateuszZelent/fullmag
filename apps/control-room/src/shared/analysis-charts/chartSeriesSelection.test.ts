import { describe, expect, it } from "vitest";

import {
  initializeSelectedSeriesIdsForUnconfiguredScope,
  replaceSelectedSeriesIdsInScope,
  sanitizeSelectedSeriesIds,
  selectAllSeriesIds,
  soloSeriesId,
  toggleSelectedSeriesId,
} from "./chartSeriesSelection";

describe("chart series selection", () => {
  const ids = ["mx", "my", "mz"];

  it.each([
    [], ["mx"], ["my"], ["mz"],
    ["mx", "my"], ["mx", "mz"], ["my", "mz"], ids,
  ].map((selected) => [selected]))("preserves the exact selection %j", (selected) => {
    expect(sanitizeSelectedSeriesIds(selected, ids)).toEqual(selected);
  });

  it("allows the final selected series to be removed", () => {
    expect(toggleSelectedSeriesId(["my"], "my", false)).toEqual([]);
  });

  it("does not restore defaults when invalid ids sanitize to empty", () => {
    expect(sanitizeSelectedSeriesIds(["missing"], ids)).toEqual([]);
  });

  it("preserves a full table ChartSeries ID for exact renderer matching", () => {
    const seriesId = "data.table:default:step:mx";
    expect(sanitizeSelectedSeriesIds([seriesId], [seriesId])).toEqual([seriesId]);
  });

  it("creates explicit solo and show-all selections", () => {
    expect(soloSeriesId("my")).toEqual(["my"]);
    expect(selectAllSeriesIds(ids)).toEqual(ids);
  });

  it("replaces only the current surface while preserving other surface IDs", () => {
    const table = "data.table:default:step:mx";
    const energy = "simulation.solver.energies:total";
    const frequency = "analysis.frequency-domain:response:mx";

    expect(
      replaceSelectedSeriesIdsInScope(
        [table, energy, frequency],
        [],
        (id) => id.startsWith("simulation.solver.energies:"),
      ),
    ).toEqual([table, frequency]);
  });

  it("initializes an unconfigured surface once without restoring an explicit empty selection", () => {
    const table = "data.table:default:step:mx";
    const energy = [
      "simulation.solver.energies:exchange",
      "simulation.solver.energies:total",
    ];

    expect(
      initializeSelectedSeriesIdsForUnconfiguredScope(
        [table],
        energy,
        false,
        (id) => id.startsWith("simulation.solver.energies:"),
      ),
    ).toEqual([table, ...energy]);
    expect(
      initializeSelectedSeriesIdsForUnconfiguredScope(
        [table],
        energy,
        true,
        (id) => id.startsWith("simulation.solver.energies:"),
      ),
    ).toEqual([table]);
  });
});
