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
      "live-charts.set-preset",
      "live-charts.set-selected-series",
      "live-charts.set-range",
      "live-charts.export.csv",
      "live-charts.export.tsv",
      "live-charts.export.png",
    ]);
  });

  it("registers Results Navigator as the Results-activated panel-left module", () => {
    expect(
      ALL_MODULES.find((module) => module.id === "results-navigator"),
    ).toMatchObject({
      id: "results-navigator",
      slots: ["panel-left"],
      title: "Results",
      activationTab: "results",
    });
  });

  it("keeps Live Charts when 3D is disabled", () => {
    expect(
      resolveControlRoomModules({ disableViewport3D: true }).map(
        (module) => module.id,
      ),
    ).toContain("live-charts");
  });
});
