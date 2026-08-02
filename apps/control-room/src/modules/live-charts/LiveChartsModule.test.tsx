import { describe, expect, it } from "vitest";

import { liveChartsManifest } from "./manifest";

describe("LiveChartsModule", () => {
  it("declares the active-run viewport module and its commands", () => {
    expect(liveChartsManifest.id).toBe("live-charts");
    expect(liveChartsManifest.slots).toEqual(["viewport-main"]);
    expect(liveChartsManifest.contributes?.commands?.map((command) => command.id)).toEqual([
      "live-charts.open", "live-charts.follow", "live-charts.pause", "live-charts.fit", "live-charts.export.csv", "live-charts.export.tsv", "live-charts.export.png",
    ]);
  });
});
