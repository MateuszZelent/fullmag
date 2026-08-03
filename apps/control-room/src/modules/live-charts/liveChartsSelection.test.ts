import { describe, expect, it } from "vitest";

import { resolveLiveChartSelectedSeriesIds } from "./liveChartsSelection";

const available = [
  { id: "data.table:default:step:mx", quantity: "mx" },
  { id: "data.table:default:step:my", quantity: "my" },
  { id: "data.table:default:step:mz", quantity: "mz" },
];

describe("resolveLiveChartSelectedSeriesIds", () => {
  it("maps persisted quantity aliases to current canonical series ids", () => {
    expect(
      resolveLiveChartSelectedSeriesIds(["mx", "missing"], available, ["mx", "my", "mz"]),
    ).toEqual(["data.table:default:step:mx"]);
  });

  it("recovers a non-empty stale selection with the preset defaults", () => {
    expect(
      resolveLiveChartSelectedSeriesIds(["old:m1"], available, ["mx", "my", "mz"]),
    ).toEqual([
      "data.table:default:step:mx",
      "data.table:default:step:my",
      "data.table:default:step:mz",
    ]);
  });

  it("preserves an intentional empty selection", () => {
    expect(
      resolveLiveChartSelectedSeriesIds([], available, ["mx", "my", "mz"]),
    ).toEqual([]);
  });
});
