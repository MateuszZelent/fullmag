import { describe, expect, it } from "vitest";

import { resolveInspectorRoute } from "./inspectorRouteCatalog";
import { AntennaFieldSolveStageInspectorPanel } from "./panels/stages/TimeAndZeroDurationStageSpecs";

describe("antenna field-solve inspector route", () => {
  it("uses the dedicated Study stage inspector rather than the magnetic field-drive inspector", () => {
    const route = resolveInspectorRoute("study.stage.antenna_field_solve");
    expect(route).toMatchObject({
      id: "study-stage-antenna-field-solve",
      title: "Antenna Field Solve",
    });
    expect(route?.component).toBe(AntennaFieldSolveStageInspectorPanel);
    expect(route?.id).not.toBe(
      resolveInspectorRoute("study.stage.add_field_drive")?.id,
    );
  });
});
