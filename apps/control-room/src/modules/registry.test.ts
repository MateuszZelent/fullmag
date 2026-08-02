import { describe, expect, it } from "vitest";

import { ALL_MODULES, resolveControlRoomModules } from "./registry";

describe("control room module registry", () => {
  it("registers Live Charts independently from Analysis", () => {
    const centerModules = ALL_MODULES.filter((module) =>
      module.slots.includes("viewport-main"),
    );

    expect(centerModules.map((module) => [module.id, module.title])).toEqual(
      expect.arrayContaining([
        ["live-charts", "Live Charts"],
        ["analysis-plots", "Analysis"],
      ]),
    );
    expect(
      ALL_MODULES.find((module) => module.id === "live-charts")?.contributes
        ?.commands?.map((command) => command.id),
    ).toEqual([
      "live-charts.open",
      "live-charts.follow",
      "live-charts.pause",
      "live-charts.fit",
      "live-charts.export.csv",
      "live-charts.export.tsv",
      "live-charts.export.png",
    ]);
  });

  it("keeps Live Charts when 3D is disabled", () => {
    expect(
      resolveControlRoomModules({ viewport3d: { enabled: false } }).map(
        (module) => module.id,
      ),
    ).toContain("live-charts");
  });
});
