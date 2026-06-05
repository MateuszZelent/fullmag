import { describe, expect, it } from "vitest";

import {
  buildStudyStagesMergePatch,
  createDefaultStudyStageDraft,
  createStudyStageDraft,
  studyStageDraftToSceneStage,
  validateStudyStageDraft,
} from "./StudyStageAuthoringModel";

describe("StudyStageAuthoringModel", () => {
  it("creates an editable relax draft from a canonical scene stage", () => {
    expect(
      createStudyStageDraft(
        {
          algorithm: "llg_overdamped",
          dt: "auto",
          dt_min: 1e-18,
          energy_tolerance: 1e-10,
          field_refresh: { every_n: 10 },
          kind: "relax",
          max_error: 1e-4,
          max_physical_time_s: 5e-9,
          max_pseudotime_s: 2e-9,
          max_steps: 1000,
          relax_alpha: 0.7,
          solver: "rk45",
          stage_id: "relax-1",
          torque_tolerance: 1e-6,
        },
        0,
      ),
    ).toMatchObject({
      algorithm: "llg_overdamped",
      dt: "auto",
      dtMin: "1e-18",
      energyTolerance: "1e-10",
      fieldEvery: "10",
      kind: "relax",
      maxError: "0.0001",
      maxPhysicalTime: "5e-9",
      maxPseudotime: "2e-9",
      maxSteps: "1000",
      relaxAlpha: "0.7",
      solver: "rk45",
      stageId: "relax-1",
      torqueTolerance: "0.000001",
    });
  });

  it("creates an editable run draft from a canonical scene stage", () => {
    expect(
      createStudyStageDraft(
        {
          kind: "run",
          stage_id: "run-1",
          until_seconds: 3e-9,
        },
        1,
      ),
    ).toMatchObject({
      kind: "run",
      stageId: "run-1",
      untilSeconds: "3e-9",
    });
  });

  it("creates editable spectral and save-state drafts", () => {
    expect(
      createStudyStageDraft(
        {
          bc: { kind: "periodic", axes: ["x"] },
          count: 12,
          damping_policy: "linearized",
          equilibrium_artifact: "artifact://relaxed",
          equilibrium_source: "provided",
          include_demag: false,
          k_sampling: { path: "gamma-x", points: 5 },
          k_vector: [0, 1, -1],
          kind: "eigenmodes",
          normalization: "max_component",
          stage_id: "modes-1",
          target: "near_frequency",
          target_frequency: 2e9,
        },
        2,
      ),
    ).toMatchObject({
      bc: '{"kind":"periodic","axes":["x"]}',
      count: "12",
      dampingPolicy: "linearized",
      equilibriumArtifact: "artifact://relaxed",
      equilibriumSource: "provided",
      includeDemag: false,
      kSampling: '{"path":"gamma-x","points":5}',
      kVector: "0, 1, -1",
      kind: "eigenmodes",
      normalization: "max_component",
      stageId: "modes-1",
      target: "near_frequency",
      targetFrequency: "2000000000",
    });

    expect(
      createStudyStageDraft(
        {
          artifact_name: "checkpoint",
          dataset: "m",
          format: "fmstate",
          kind: "save_state",
          stage_id: "save-1",
        },
        3,
      ),
    ).toMatchObject({
      artifactName: "checkpoint",
      dataset: "m",
      format: "fmstate",
      kind: "save_state",
      stageId: "save-1",
    });
  });

  it("creates and serializes hysteresis drafts", () => {
    expect(
      createStudyStageDraft(
        {
          field_steps: 17,
          kind: "hysteresis",
          stage_id: "h-loop",
          start_field: [0, 0, -0.1],
          stop_field: [0, 0, 0.1],
          torque_tolerance: 1e-6,
        },
        4,
      ),
    ).toMatchObject({
      fieldSteps: "17",
      kind: "hysteresis",
      stageId: "h-loop",
      startField: "0, 0, -0.1",
      stopField: "0, 0, 0.1",
      torqueTolerance: "0.000001",
    });

    expect(
      studyStageDraftToSceneStage({
        ...createDefaultStudyStageDraft("hysteresis", 0),
        fieldSteps: "21",
        stageId: "h-loop",
        startField: "0, 0, -0.2",
        stopField: "0, 0, 0.2",
        torqueTolerance: "5e-7",
      }),
    ).toEqual({
      entrypoint_kind: "flat_hysteresis",
      field_steps: 21,
      hysteresis_start_field: [0, 0, -0.2],
      hysteresis_stop_field: [0, 0, 0.2],
      hysteresis_torque_tolerance: 5e-7,
      kind: "hysteresis",
      stage_id: "h-loop",
      start_field: [0, 0, -0.2],
      stop_field: [0, 0, 0.2],
      torque_tolerance: 5e-7,
    });
  });

  it("serializes relax and run drafts into a study stages merge patch", () => {
    const relax = {
      ...createDefaultStudyStageDraft("relax", 0),
      dt: "auto",
      dtMin: "1e-18",
      energyTolerance: "1e-10",
      fieldEvery: "10",
      maxError: "1e-4",
      maxPhysicalTime: "5e-9",
      maxPseudotime: "2e-9",
      maxSteps: "1000",
      relaxAlpha: "0.7",
      solver: "rk45",
      stageId: "relax-1",
      torqueTolerance: "1e-6",
    };
    const run = {
      ...createDefaultStudyStageDraft("run", 1),
      stageId: "run-2",
      untilSeconds: "3e-9",
    };

    expect(buildStudyStagesMergePatch([relax, run])).toEqual({
      kind: "merge_patch",
      merge_patch: {
        study: {
          stages: [
            {
              algorithm: "llg_overdamped",
              dt: "auto",
              dt_min: 1e-18,
              energy_tolerance: 1e-10,
              entrypoint_kind: "flat_relax",
              field_refresh: { every_n: 10 },
              fixed_timestep: "",
              integrator: "rk45",
              kind: "relax",
              max_error: 1e-4,
              max_physical_time_s: 5e-9,
              max_pseudotime_s: 2e-9,
              max_steps: 1000,
              relax_algorithm: "llg_overdamped",
              relax_alpha: 0.7,
              solver: "rk45",
              stage_id: "relax-1",
              torque_tolerance: 1e-6,
            },
            {
              entrypoint_kind: "flat_run",
              kind: "run",
              stage_id: "run-2",
              until_seconds: 3e-9,
            },
          ],
        },
      },
    });
  });

  it("serializes fixed relax dt as a numeric timestep", () => {
    expect(
      studyStageDraftToSceneStage({
        ...createDefaultStudyStageDraft("relax", 0),
        dt: "5e-15",
      }),
    ).toMatchObject({
      dt: 5e-15,
      fixed_timestep: 5e-15,
    });
  });

  it("serializes eigenmodes, frequency response, and save-state stages", () => {
    expect(
      studyStageDraftToSceneStage({
        ...createDefaultStudyStageDraft("eigenmodes", 0),
        bc: '{"kind":"periodic","axes":["x"]}',
        count: "4",
        dampingPolicy: "linearized",
        equilibriumArtifact: "artifact://relaxed",
        equilibriumSource: "provided",
        includeDemag: false,
        kSampling: '{"points":5}',
        kVector: "0, 1, -1",
        normalization: "max_component",
        stageId: "modes-1",
        target: "near_frequency",
        targetFrequency: "2e9",
      }),
    ).toEqual({
      bc: { axes: ["x"], kind: "periodic" },
      count: 4,
      damping_policy: "linearized",
      eigen_count: 4,
      eigen_damping_policy: "linearized",
      eigen_equilibrium_artifact: "artifact://relaxed",
      eigen_equilibrium_source: "provided",
      eigen_include_demag: false,
      eigen_k_sampling: { points: 5 },
      eigen_k_vector: [0, 1, -1],
      eigen_normalization: "max_component",
      eigen_spin_wave_bc: { axes: ["x"], kind: "periodic" },
      eigen_target: "near_frequency",
      eigen_target_frequency: 2e9,
      equilibrium_artifact: "artifact://relaxed",
      equilibrium_source: "provided",
      entrypoint_kind: "flat_eigenmodes",
      include_demag: false,
      k_sampling: { points: 5 },
      k_vector: [0, 1, -1],
      kind: "eigenmodes",
      normalization: "max_component",
      stage_id: "modes-1",
      target: "near_frequency",
      target_frequency: 2e9,
    });

    expect(
      studyStageDraftToSceneStage({
        ...createDefaultStudyStageDraft("frequency_response", 1),
        excitationField: "0, -2, 3",
        frequenciesHz: "1e9, 2e9",
        observable: "mx",
        stageId: "freq-1",
      }),
    ).toMatchObject({
      entrypoint_kind: "flat_frequency_response",
      excitation_field_au_per_m: [0, -2, 3],
      frequency_excitation_field_au_per_m: [0, -2, 3],
      frequency_observable: "mx",
      frequency_values_hz: [1e9, 2e9],
      frequencies_hz: [1e9, 2e9],
      kind: "frequency_response",
      observable: "mx",
      stage_id: "freq-1",
    });

    expect(
      studyStageDraftToSceneStage({
        ...createDefaultStudyStageDraft("save_state", 2),
        artifactName: "final-state",
        dataset: "m",
        format: "fmstate",
        stageId: "save-1",
      }),
    ).toEqual({
      artifact_name: "final-state",
      dataset: "m",
      entrypoint_kind: "flat_save_state",
      format: "fmstate",
      kind: "save_state",
      stage_id: "save-1",
    });
  });

  it("validates spectral lists, vectors, and JSON object fields", () => {
    expect(
      validateStudyStageDraft({
        ...createDefaultStudyStageDraft("frequency_response", 0),
        bc: "{bad",
        excitationField: "1, 2",
        frequenciesHz: "0 -1",
        kSampling: "[]",
      }).map((issue) => issue.message),
    ).toEqual([
      "Frequencies requires at least one positive finite number.",
      "Excitation field must contain three finite numbers.",
      "k sampling must be a JSON object.",
      "BC must be a boundary condition name or JSON object.",
    ]);
  });

  it("validates required positive stage fields", () => {
    expect(
      validateStudyStageDraft({
        ...createDefaultStudyStageDraft("relax", 0),
        maxSteps: "0",
        stageId: "",
        torqueTolerance: "-1",
      }).map((issue) => issue.message),
    ).toEqual([
      "Stage ID is required.",
      "Torque tolerance must be a positive finite number.",
      "Max steps must be a positive integer.",
    ]);

    expect(
      validateStudyStageDraft({
        ...createDefaultStudyStageDraft("run", 0),
        untilSeconds: "",
      }).map((issue) => issue.message),
    ).toEqual(["Until seconds is required."]);

    expect(
      validateStudyStageDraft({
        ...createDefaultStudyStageDraft("hysteresis", 0),
        fieldSteps: "0",
        startField: "0, 1",
        stopField: "",
        torqueTolerance: "-1",
      }).map((issue) => issue.message),
    ).toEqual([
      "Torque tolerance must be a positive finite number.",
      "Start field must contain three finite numbers.",
      "Stop field must contain three finite numbers.",
      "Field steps must be a positive integer.",
    ]);
  });
});
