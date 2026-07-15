import { describe, expect, it } from "vitest";

import { EMPTY_SELECTION } from "@/kernel/selection/selectionTypes";

import {
  buildAntennaLegacyMigrationPatch,
  resolveAntennaObjectPanelModel,
} from "./AntennaObjectPanelModel";

describe("AntennaObjectPanelModel", () => {
  it("resolves prescribed Zeeman mask antenna details from SceneResource", () => {
    const model = resolveAntennaObjectPanelModel(
      {
        ...EMPTY_SELECTION,
        objectId: "center_microstrip",
        ref: {
          kind: "object.antenna",
          nodeId: "model:object:center_microstrip:antenna",
          objectId: "center_microstrip",
          type: "scene-object",
          visualizationTargetId: "object:center_microstrip",
        },
      },
      {
        current_modules: {
          modules: [
            {
              B: 0.001,
              direction: [0, 1, 0],
              kind: "antenna_field_source",
              model: "prescribed_zeeman_mask",
              name: "center_drive",
              object: "center_microstrip",
              spatial_profile: { kind: "uniform" },
              waveform: { cutoff_hz: 20e9, kind: "sinc_pulse", t0: 50e-12 },
            },
          ],
        },
      } as never,
    );

    expect(model).toMatchObject({
      amplitude: "1.000e-3 T",
      direction: "(0.000e+0, 1.000e+0, 0.000e+0)",
      mode: "legacy",
      objectId: "center_microstrip",
      source: "center_drive",
      spatialProfile: "uniform",
      waveform: "sinc pulse, cutoff 20 GHz, t0 5.000e-11 s",
    });
  });

  it("formats sinusoidal antenna frequency with automatic display units", () => {
    const model = resolveAntennaObjectPanelModel(
      {
        ...EMPTY_SELECTION,
        objectId: "center_microstrip",
        ref: {
          kind: "object.antenna",
          nodeId: "model:object:center_microstrip:antenna",
          objectId: "center_microstrip",
          type: "scene-object",
          visualizationTargetId: "object:center_microstrip",
        },
      },
      {
        current_modules: {
          modules: [
            {
              B: 0.001,
              direction: [0, 1, 0],
              kind: "antenna_field_source",
              model: "prescribed_zeeman_mask",
              name: "center_drive",
              object: "center_microstrip",
              spatial_profile: { kind: "uniform" },
              waveform: { frequency_hz: 750e6, kind: "sinusoidal" },
            },
          ],
        },
      } as never,
    );

    expect(model.waveform).toBe("sin, 750 MHz");
  });

  it("migrates a legacy source to one canonical geometry-mask drive", () => {
    const selection = { ...EMPTY_SELECTION, objectId: "antenna" };
    const patch = buildAntennaLegacyMigrationPatch(selection, {
      field_drives: { drives: [] },
      current_modules: { modules: [{ id:"old",name:"Old",kind:"antenna_field_source",model:"prescribed_zeeman_mask",object:"antenna",B:0.001,direction:[0,1,0],spatial_profile:{kind:"uniform"} }] },
    } as never, {
      amplitudeB:"0.001",direction:"0, 1, 0",waveformKind:"constant",sincCutoffHz:"2e10",sincT0:"5e-11",sinusoidalFrequencyHz:"1e10",
    });
    expect(patch.error).toBeNull();
    expect(patch.modules).toEqual([]);
    expect(patch.drives?.[0]).toMatchObject({ id:"old",kind:"regional",migration:{migrated_from:"prescribed_zeeman_mask"},spatial_profile:{kind:"geometry_mask",object_id:"antenna"} });
  });
});
