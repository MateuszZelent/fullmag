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
      fieldMaxMt: "100",
      fieldMinMt: "-100",
      fieldStepMt: "12.5",
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
        fieldMaxMt: "200",
        fieldMinMt: "-200",
        fieldStepMt: "20",
        stageId: "h-loop",
        torqueTolerance: "5e-7",
      }),
    ).toEqual({
      branch_mode: "major_loop",
      entrypoint_kind: "flat_hysteresis",
      field_max_mT: 200,
      field_min_mT: -200,
      field_step_mT: 20,
      hysteresis_torque_tolerance: 5e-7,
      initial_protocol: "positive_saturation",
      kind: "hysteresis",
      measurement_axis: "field_axis",
      orientation: {
        kind: "preset",
        preset_name: "oop_positive",
      },
      settle_pipeline: {
        kind: "sequence",
        steps: [
          {
            alpha: 1,
            kind: "relax",
            max_steps: 10000,
            method: "llg_overdamped",
            on_non_convergence: "continue_with_warning",
            torque_tolerance: expect.any(Number),
          },
        ],
      },
      stage_id: "h-loop",
      storage: {
        every_n: 5,
        key_event_threshold_dm: 0.02,
        key_events: true,
        magnetization: "selected",
        scalar_history: true,
      },
      torque_tolerance: 5e-7,
    });
  });

  it("keeps default hysteresis authoring aligned with the Study ribbon preset", () => {
    const stage = studyStageDraftToSceneStage(
      createDefaultStudyStageDraft("hysteresis", 0),
    );

    expect(stage).toMatchObject({
      branch_mode: "major_loop",
      entrypoint_kind: "flat_hysteresis",
      field_max_mT: 100,
      field_min_mT: -100,
      field_step_mT: 10,
      initial_protocol: "positive_saturation",
      kind: "hysteresis",
      measurement_axis: "field_axis",
      orientation: {
        kind: "preset",
        preset_name: "oop_positive",
      },
      settle_pipeline: {
        kind: "sequence",
        steps: [
          {
            kind: "relax",
            method: "llg_overdamped",
          },
        ],
      },
      stage_id: "hysteresis-1",
    });
  });

  it("accepts zero-valued sample orientation angles for OOP/IP hysteresis authoring", () => {
    expect(
      validateStudyStageDraft({
        ...createDefaultStudyStageDraft("hysteresis", 0),
        orientationMode: "sample",
        thetaDeg: "0",
        phiDeg: "0",
      }),
    ).toEqual([]);
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
        fieldMaxMt: "nan",
        fieldMinMt: "",
        fieldStepMt: "0",
        torqueTolerance: "-1",
      }).map((issue) => issue.message),
    ).toEqual([
      "Torque tolerance must be a positive finite number.",
      "Minimum field is required.",
      "Maximum field must be a finite number.",
      "Field step must be a positive finite number.",
    ]);
  });

  it("rejects malformed hysteresis JSON authoring fields", () => {
    expect(
      validateStudyStageDraft({
        ...createDefaultStudyStageDraft("hysteresis", 0),
        denseWindows: "{}",
        fieldSegments: "{}",
        minorLoops: "{}",
        settleBranches: "{}",
        settleSteps: "{}",
        storagePolicy: "[]",
      }).map((issue) => issue.message),
    ).toEqual([
      "Settle steps must be a valid JSON array.",
      "Settle branches must be a valid JSON array.",
      "Field segments must be a valid JSON array.",
      "Dense windows must be a valid JSON array.",
      "Minor loops must be a valid JSON array.",
      "Storage policy must be a valid JSON object.",
    ]);
  });

  it("validates hysteresis piecewise field segment shape", () => {
    expect(
      validateStudyStageDraft({
        ...createDefaultStudyStageDraft("hysteresis", 0),
        fieldScheduleMode: "piecewise",
        fieldSegments: JSON.stringify([
          {
            label: "bad segment",
            startField: 25,
            stopField: 25,
            step: 0,
          },
        ]),
      }).map((issue) => issue.message),
    ).toEqual([
      "Field segment 1 requires segmentId.",
      "Field segment 1 requires endpointPolicy.",
      "Field segment 1 step must be a positive finite number.",
      "Field segment 1 startField and stopField must differ.",
    ]);
  });

  it("serializes UI-authored hysteresis piecewise segments to canonical keys", () => {
    expect(
      studyStageDraftToSceneStage({
        ...createDefaultStudyStageDraft("hysteresis", 0),
        fieldScheduleMode: "piecewise",
        fieldSegments: JSON.stringify([
          {
            endpointPolicy: "include_stop",
            label: "coarse start",
            reason: "far_from_remanence",
            segmentId: "coarse_start",
            startField: 100,
            step: 20,
            stopField: -20,
          },
        ]),
      }),
    ).toMatchObject({
      field_schedule: {
        segments: [
          {
            endpoint_policy: "include_stop",
            label: "coarse start",
            reason: "far_from_remanence",
            segment_id: "coarse_start",
            start: 100,
            step: 20,
            stop: -20,
          },
        ],
      },
    });
  });

  it("serializes UI-authored hysteresis dense windows and minor loops to canonical keys", () => {
    expect(
      studyStageDraftToSceneStage({
        ...createDefaultStudyStageDraft("hysteresis", 0),
        denseWindows: JSON.stringify([
          {
            centerMt: 0,
            halfWidthMt: 25,
            priority: 10,
            reason: "remanence",
            stepMt: 1,
          },
        ]),
        minorLoops: JSON.stringify([
          {
            returnMt: -25,
            reversalMt: 25,
          },
        ]),
        protocolKind: "major_with_minor_loops",
      }),
    ).toMatchObject({
      minor_loops: [
        {
          return_mT: -25,
          reversal_mT: 25,
        },
      ],
      schedule_refinements: [
        {
          center_mT: 0,
          half_width_mT: 25,
          priority: 10,
          reason: "remanence",
          step_mT: 1,
        },
      ],
    });
  });
});
