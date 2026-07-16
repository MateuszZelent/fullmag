import { describe, expect, it } from "vitest";

import { regionalFieldDriveSamplingContext, regionalFieldDriveSelectorOptions, resolveRegionalFieldDrivePanelModel } from "./RegionalFieldDrivePanelModel";

describe("RegionalFieldDrivePanelModel", () => {
  it("derives only canonical object, region, and stable run-stage selectors", () => {
    const options = regionalFieldDriveSelectorOptions({
      objects: [{ id: "film", name: "Film", regions: [{ region_id: "edge", name: "Edge", shape: { kind: "box", center: [0, 0, 0], size: [1, 1, 1] } }] }],
      study: { stages: [{ kind: "relax", stage_id: "relax" }, { kind: "run", stage_id: "ringdown" }, { kind: "run" }] },
    });

    expect(options.objects).toEqual([{ id: "film", label: "Film (film)" }]);
    expect(options.regionsByObject.film).toEqual([{ id: "edge", label: "Edge (edge)" }]);
    expect(options.timeEvolutionStages).toEqual([{ id: "ringdown", label: "ringdown (run 2)" }]);
  });

  it("resolves a dedicated field-drive selection", () => {
    const model = resolveRegionalFieldDrivePanelModel(
      {
        kind: "physics.field-drive",
        label: "Pulse",
        moduleSource: "explorer",
        nodeId: "model:physics:field-drives:pulse",
        objectId: null,
        ref: {
          fieldDriveId: "pulse",
          kind: "physics.field-drive",
          nodeId: "model:physics:field-drives:pulse",
          type: "physics-field-drive",
        },
      },
      {
        scene_revision: 7,
        drives: [{
          id: "pulse",
          name: "Pulse",
          kind: "regional",
          enabled: true,
          target: { kind: "global" },
          amplitude_B_T: 1e-3,
          direction: [0, 1, 0],
          spatial_profile: { kind: "uniform" },
          waveform: { kind: "constant" },
          time_origin: "stage_local",
          activation: { kind: "all_time_evolution" },
        }],
      },
    );
    expect(model.mode).toBe("found");
    expect(model.sceneRevision).toBe(7);
  });

  it("derives t_sampling and active run duration from canonical scene study data", () => {
    const context = regionalFieldDriveSamplingContext(
      {
        outputs: { table_autosave: { sample_period_s: 0.5e-12 } },
        study: {
          solver: { dt: 0.1e-12 },
          stages: [{ kind: "run", stage_id: "excite", until: 100e-12 }],
        },
      },
      { kind: "stage_ids", stage_ids: ["excite"] },
    );
    expect(context.samplePeriodS).toBe(0.5e-12);
    expect(context.solverDtS).toBe(0.1e-12);
    expect(context.durationS).toBe(100e-12);
  });
});
