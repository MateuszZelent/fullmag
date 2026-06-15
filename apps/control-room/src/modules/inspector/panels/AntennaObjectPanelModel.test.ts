import { describe, expect, it } from "vitest";

import { EMPTY_SELECTION } from "@/kernel/selection/selectionTypes";

import {
  buildAntennaCurrentModulesPatch,
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
      mode: "present",
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

  it("builds a current_modules merge patch for edited antenna waveform", () => {
    const selection = {
      ...EMPTY_SELECTION,
      objectId: "center_microstrip",
      ref: {
        kind: "object.antenna" as const,
        nodeId: "model:object:center_microstrip:antenna",
        objectId: "center_microstrip",
        type: "scene-object" as const,
        visualizationTargetId: "object:center_microstrip" as const,
      },
    };
    const patch = buildAntennaCurrentModulesPatch(
      selection,
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
            },
          ],
        },
      } as never,
      {
        amplitudeB: "0.002",
        direction: "1, 0, 0",
        sincCutoffHz: "30000000000",
        sincT0: "6e-11",
        sinusoidalFrequencyHz: "10000000000",
        waveformKind: "sinc_pulse",
      },
    );

    expect(patch.error).toBeNull();
    expect(patch.modules?.[0]).toMatchObject({
      B: 0.002,
      direction: [1, 0, 0],
      waveform: { cutoff_hz: 30e9, kind: "sinc_pulse", t0: 6e-11 },
    });
  });
});
