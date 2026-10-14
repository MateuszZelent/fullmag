import { describe, expect, it } from "vitest";

import { EMPTY_SELECTION } from "@/kernel/selection/selectionTypes";

import {
  antennaObjectDraftKey,
  buildAntennaCanonicalFieldDrive,
  buildAntennaLegacyMigrationPatch,
  resolveAntennaObjectDraft,
  resolveAntennaObjectPanelModel,
} from "./AntennaObjectPanelModel";

describe("AntennaObjectPanelModel", () => {
  it("keeps the draft identity stable across unrelated scene revisions", () => {
    const selection = { ...EMPTY_SELECTION, objectId: "antenna" };
    const scene = {
      revision: 11,
      field_drives: {
        drives: [{
          id: "drive",
          kind: "regional",
          spatial_profile: { kind: "geometry_mask", object_id: "antenna" },
          waveform: { kind: "constant" },
        }],
      },
    } as never;
    const nextScene = {
      revision: 12,
      field_drives: {
        drives: [{
          id: "drive",
          kind: "regional",
          spatial_profile: { kind: "geometry_mask", object_id: "antenna" },
          waveform: { kind: "constant" },
        }],
      },
    } as never;

    expect(antennaObjectDraftKey(selection, scene)).toBe(
      antennaObjectDraftKey(selection, nextScene),
    );
  });

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
      amplitudeB:"0.001",direction:"0, 1, 0",waveformKind:"constant",sincAmplitude:"1",sincCutoffHz:"2e10",sincT0:"5e-11",sinusoidalFrequencyHz:"1e10",sinusoidalOffset:"0",sinusoidalPhaseRad:"0",
    });
    expect(patch.error).toBeNull();
    expect(patch.modules).toEqual([]);
    expect(patch.drives?.[0]).toMatchObject({ id:"old",kind:"regional",migration:{migrated_from:"prescribed_zeeman_mask"},spatial_profile:{kind:"geometry_mask",object_id:"antenna"} });
  });

  it("round-trips sinusoidal phase and offset through the antenna draft", () => {
    const selection = { ...EMPTY_SELECTION, objectId: "antenna" };
    const scene = {
      field_drives: {
        drives: [{
          id: "drive",
          kind: "regional",
          amplitude_B_T: 0.001,
          direction: [0, 1, 0],
          spatial_profile: { kind: "geometry_mask", object_id: "antenna" },
          waveform: {
            kind: "sinusoidal",
            frequency_hz: 1e9,
            phase_rad: 0.4,
            offset: 0.2,
          },
        }],
      },
    } as never;

    const draft = resolveAntennaObjectDraft(selection, scene);
    expect(draft).toMatchObject({
      sinusoidalFrequencyHz: "1000000000",
      sinusoidalPhaseRad: "0.4",
      sinusoidalOffset: "0.2",
    });

    const patch = buildAntennaCanonicalFieldDrive(selection, scene, draft);
    expect(patch.error).toBeNull();
    expect(patch.drive?.waveform).toEqual({
      kind: "sinusoidal",
      frequency_hz: 1e9,
      phase_rad: 0.4,
      offset: 0.2,
    });
  });

  it("round-trips the sinc waveform amplitude instead of resetting it to one", () => {
    const selection = { ...EMPTY_SELECTION, objectId: "antenna" };
    const scene = {
      field_drives: {
        drives: [{
          id: "drive",
          kind: "regional",
          spatial_profile: { kind: "geometry_mask", object_id: "antenna" },
          waveform: { kind: "sinc_pulse", cutoff_hz: 2e10, t0: 5e-11, amplitude: 0.35 },
        }],
      },
    } as never;

    const draft = resolveAntennaObjectDraft(selection, scene);
    expect(draft.sincAmplitude).toBe("0.35");
    const patch = buildAntennaCanonicalFieldDrive(selection, scene, draft);
    expect(patch.error).toBeNull();
    expect(patch.drive?.waveform).toEqual({
      kind: "sinc_pulse",
      cutoff_hz: 2e10,
      t0: 5e-11,
      amplitude: 0.35,
    });
  });

  it("rejects blank sinusoidal parameters instead of saving them as zero", () => {
    const selection = { ...EMPTY_SELECTION, objectId: "antenna" };
    const scene = {
      field_drives: { drives: [{
        id: "drive",
        kind: "regional",
        amplitude_B_T: 0.001,
        direction: [0, 1, 0],
        spatial_profile: { kind: "geometry_mask", object_id: "antenna" },
        waveform: { kind: "sinusoidal", frequency_hz: 1e9, phase_rad: 0.4, offset: 0.2 },
      }] },
    } as never;
    const draft = resolveAntennaObjectDraft(selection, scene);

    expect(buildAntennaCanonicalFieldDrive(selection, scene, {
      ...draft, sinusoidalPhaseRad: "  ",
    }).error).toBe("Sinusoidal phase is required.");
    expect(buildAntennaCanonicalFieldDrive(selection, scene, {
      ...draft, sinusoidalOffset: "",
    }).error).toBe("Sinusoidal offset is required.");
  });

  it("rejects a blank sinc amplitude instead of silently disabling excitation", () => {
    const selection = { ...EMPTY_SELECTION, objectId: "antenna" };
    const scene = {
      field_drives: { drives: [{
        id: "drive",
        kind: "regional",
        amplitude_B_T: 0.001,
        direction: [0, 1, 0],
        spatial_profile: { kind: "geometry_mask", object_id: "antenna" },
        waveform: { kind: "sinc_pulse", cutoff_hz: 2e10, t0: 5e-11, amplitude: 0.35 },
      }] },
    } as never;
    const draft = resolveAntennaObjectDraft(selection, scene);

    expect(buildAntennaCanonicalFieldDrive(selection, scene, {
      ...draft, sincAmplitude: "",
    }).error).toBe("Sinc amplitude is required.");
  });
});
