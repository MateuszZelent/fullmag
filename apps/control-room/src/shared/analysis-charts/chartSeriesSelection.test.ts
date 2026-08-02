import { describe, expect, it } from "vitest";

import {
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
});
