import { describe, expect, it } from "vitest";

import { resolveInspectorRoute } from "./inspectorRouteCatalog";
import { StudyStageInspectorRouter } from "./panels/StudyStageInspectorRouter";

describe("antenna field-solve inspector route", () => {
  it("uses the Study router rather than the magnetic field-drive inspector", () => {
    const route = resolveInspectorRoute("study.stage.antenna_field_solve");
    expect(route).toMatchObject({
      id: "study-stage-antenna-field-solve",
      title: "Antenna Field Solve",
    });
    expect(route?.component).toBe(StudyStageInspectorRouter);
    expect(route?.id).not.toBe(
      resolveInspectorRoute("study.stage.add_field_drive")?.id,
    );
  });
});
