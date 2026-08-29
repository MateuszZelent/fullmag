import { describe, expect, it } from "vitest";
import type { ActiveLaneCapabilitySnapshot } from "@/kernel/resources/useActiveLaneCapabilities";

import {
  buildStudyStagesMergePatch,
  createDefaultStudyStageDraft,
  createStudyStageDraft,
  createStudyStageDrafts,
  relaxationAlgorithmAvailability,
  studyStageDraftToSceneStage,
  validateStudyStageDraft,
} from "./StudyStageAuthoringModel";

function activeLaneSnapshot({
  device,
  mode,
  operations,
  precision,
}: {
  device: string;
  mode: string;
  operations: ActiveLaneCapabilitySnapshot["operations"];
  precision: string;
}): ActiveLaneCapabilitySnapshot {
  const identity = {
    backend: "fem",
    device,
    discretization: "fem",
    mode,
    precision,
  };
  return {
    schema_version: "active-lane-capabilities.v2",
    authored: identity,
    requested: identity,
    resolved: identity,
    source: {
      kind: "planner",
      capability_profile_version: "test",
      engine_id: "test-fem",
      authored_intent: "problem_ir.runtime_selection",
      effective_request: "session.runtime_resolution",
    },
    qualification: { status: "not_asserted", reason: "Test fixture." },
    operations,
  };
}

describe("StudyStageAuthoringModel", () => {
  it.each([
    ["cpu", "double", "strict"],
    ["gpu", "single", "extended"],
  ])(
    "uses planner operation state for spectral stages on %s/%s/%s",
    (device, precision, mode) => {
      const activeLane = activeLaneSnapshot({
        device,
        mode,
        precision,
        operations: {
          "study.eigenmodes": {
            state: "supported",
            reason_code: "capability_supported",
            reason: "Eigenmode execution is supported for this resolved lane.",
            requires: [],
          },
          "study.frequency_response": {
            state: "deferred",
            reason_code: "capability_deferred",
            reason: "Frequency response is deferred for this resolved lane.",
            requires: ["planner:frequency_response"],
          },
          "study.fft": {
            state: "unsupported",
            reason_code: "capability_unsupported",
            reason: "FFT is unavailable for this resolved lane.",
            requires: ["field_quantity"],
          },
        },
      });

      expect(
        validateStudyStageDraft(createDefaultStudyStageDraft("eigenmodes", 0), {
          activeLane,
          backend: "fem",
          device,
          mode,
          precision,
        }).filter((issue) => issue.message.includes("resolved lane")),
      ).toEqual([]);
      expect(
        validateStudyStageDraft(createDefaultStudyStageDraft("frequency_response", 0), {
          activeLane,
          backend: "fem",
          device,
          mode,
          precision,
        }),
      ).toContainEqual({
        message: "Frequency response is deferred for this resolved lane.",
        severity: "warning",
      });
      expect(
        validateStudyStageDraft(createDefaultStudyStageDraft("fft_response", 0), {
          activeLane,
          backend: "fem",
          device,
          mode,
          precision,
        }),
      ).toContainEqual({
        message: "FFT is unavailable for this resolved lane.",
        severity: "error",
      });
    },
  );

  it("fails closed for a spectral stage when active-lane status is unresolved", () => {
    expect(
      validateStudyStageDraft(createDefaultStudyStageDraft("eigenmodes", 0), {
        activeLane: null,
        backend: "auto",
        device: "auto",
        mode: "strict",
        precision: "double",
      }),
    ).toContainEqual({
      message: "Active-lane capability snapshot is unavailable.",
      severity: "error",
    });
  });

  it.each([
    ["relax", "study.relaxation"],
    ["run", "study.time_integration"],
  ] as const)(
    "blocks an unsupported %s draft through %s",
    (kind, operationId) => {
      const activeLane = activeLaneSnapshot({
        device: "cpu",
        mode: "strict",
        precision: "double",
        operations: {
          [operationId]: {
            state: "unsupported",
            reason_code: "capability_unsupported",
            reason: `${operationId} is unavailable for this resolved lane.`,
            requires: ["planner:resolved_lane"],
          },
        },
      });

      expect(
        validateStudyStageDraft(createDefaultStudyStageDraft(kind, 0), {
          activeLane,
          backend: "fdm",
          device: "cpu",
          mode: "strict",
          precision: "double",
        }),
      ).toContainEqual({
        message: `${operationId} is unavailable for this resolved lane.`,
        severity: "error",
      });
    },
  );

  it.each(["relax", "run"] as const)(
    "fails closed for an unresolved %s draft",
    (kind) => {
      expect(
        validateStudyStageDraft(createDefaultStudyStageDraft(kind, 0), {
          activeLane: null,
          backend: "auto",
          device: "auto",
          mode: "strict",
          precision: "double",
        }),
      ).toContainEqual({
        message: "Active-lane capability snapshot is unavailable.",
        severity: "error",
      });
    },
  );

  it.each([
    ["relax", "study.relaxation"],
    ["run", "study.time_integration"],
  ] as const)("accepts a supported %s draft", (kind, operationId) => {
    const activeLane = activeLaneSnapshot({
      device: "cpu",
      mode: "strict",
      precision: "double",
      operations: {
        [operationId]: {
          state: "supported",
          reason_code: "capability_supported",
          reason: `${operationId} is supported for this resolved lane.`,
          requires: ["planner:resolved_lane"],
        },
      },
    });

    expect(
      validateStudyStageDraft(createDefaultStudyStageDraft(kind, 0), {
        activeLane,
        backend: "fdm",
        device: "cpu",
        mode: "strict",
        precision: "double",
      }).some((issue) => issue.message.includes(operationId)),
    ).toBe(false);
  });

  it("uses canonical relaxation defaults", () => {
    expect(createDefaultStudyStageDraft("relax", 0)).toMatchObject({
      algorithm: "llg_overdamped",
      maxSteps: "50000",
      torqueTolerance: "0.0001",
    });
  });

  it("serializes an add-field-drive instruction with the complete antenna payload", () => {
    const draft = createDefaultStudyStageDraft("add_field_drive", 1);

    expect(studyStageDraftToSceneStage(draft)).toEqual({
      drive: {
        activation: { kind: "all_time_evolution" },
        amplitude_B_T: 1e-3,
        direction: [0, 1, 0],
        enabled: true,
        id: "k0-sinc-antenna",
        kind: "regional",
        name: "Uniform transverse k0 sinc antenna",
        spatial_profile: { kind: "uniform" },
        target: { kind: "global" },
        time_origin: "stage_local",
        waveform: {
          amplitude: 1,
          cutoff_hz: 40e9,
          kind: "sinc_pulse",
          t0: 50e-12,
        },
      },
      entrypoint_kind: "flat_add_field_drive",
      kind: "add_field_drive",
      stage_id: "add_field_drive-2",
    });
  });

  it("round-trips visible sampling and FFT configuration stages before a simple Run", () => {
    const table = createStudyStageDraft({
      enabled: true,
      entrypoint_kind: "flat_table_autosave",
      kind: "table_autosave",
      stage_id: "table-on",
      table_autosave: {
        kind: "table_autosave",
        quantities: ["t", "step", "mx", "my", "mz", "e_drive"],
        sample_period_s: 0.5e-12,
        table_id: "default",
      },
    }, 0);
    const autosave = createStudyStageDraft({
      enabled: true,
      entrypoint_kind: "flat_autosave",
      kind: "autosave",
      output: { every_seconds: 2e-12, kind: "field", name: "m" },
      quantity: "m",
      stage_id: "autosave-m",
    }, 1);
    const fft = createStudyStageDraft({
      enabled: true,
      entrypoint_kind: "flat_fft_response",
      kind: "fft_response",
      request: {
        analysis: "gamma",
        detrend: "linear",
        response_component: "my",
        schema_version: "spin_wave_response.request.v1",
        susceptibility_floor_fraction: 1e-6,
        weighting: "Ms_times_lumped_volume",
        window: "hann",
      },
      stage_id: "fft-on",
    }, 2);
    const run = createStudyStageDraft({
      entrypoint_kind: "flat_run",
      kind: "run",
      stage_id: "excite",
      until_seconds: 2e-9,
    }, 3);

    expect(table).toMatchObject({
      kind: "table_autosave",
      stageId: "table-on",
      tableAutosave: {
        enabled: true,
        samplePeriodS: "5e-13",
        tableQuantities: "t, step, mx, my, mz, e_drive",
      },
    });
    expect(autosave).toMatchObject({
      autosave: {
        clearAll: false,
        enabled: true,
        everySeconds: "2e-12",
        outputKind: "field",
        quantity: "m",
      },
      kind: "autosave",
    });
    expect(fft).toMatchObject({
      fftResponse: {
        detrend: "linear",
        enabled: true,
        responseComponent: "my",
        susceptibilityFloorFraction: "0.000001",
      },
      kind: "fft_response",
    });
    expect(studyStageDraftToSceneStage(table)).toMatchObject({
      enabled: true,
      kind: "table_autosave",
    });
    expect(studyStageDraftToSceneStage(autosave)).toMatchObject({
      enabled: true,
      kind: "autosave",
      quantity: "m",
    });
    expect(studyStageDraftToSceneStage(fft)).toMatchObject({
      enabled: true,
      kind: "fft_response",
    });
    expect(studyStageDraftToSceneStage(run)).toEqual({
      entrypoint_kind: "flat_run",
      kind: "run",
      stage_id: "excite",
      until_seconds: 2e-9,
    });
  });

  it("round-trips automatic sinc sampling for table and field outputs", () => {
    const policy = {
      kind: "auto_sinc_cutoff",
      nyquist_guard_factor: 1.3,
    };
    const table = createStudyStageDraft({
      enabled: true,
      entrypoint_kind: "flat_table_autosave",
      kind: "table_autosave",
      stage_id: "table-auto",
      table_autosave: {
        kind: "table_autosave",
        quantities: ["t", "my"],
        sample_period_policy: policy,
        table_id: "default",
      },
    }, 0);
    const autosave = createStudyStageDraft({
      enabled: true,
      entrypoint_kind: "flat_autosave",
      kind: "autosave",
      output: {
        kind: "field_auto",
        name: "m",
        sample_period_policy: policy,
      },
      quantity: "m",
      stage_id: "autosave-auto",
    }, 1);

    expect(table.tableAutosave).toMatchObject({
      readOnly: false,
      samplingMode: "auto_sinc_cutoff",
    });
    expect(autosave.autosave).toMatchObject({
      outputKind: "field",
      readOnly: false,
      samplingMode: "auto_sinc_cutoff",
    });
    expect(studyStageDraftToSceneStage(table)).toMatchObject({
      table_autosave: {
        sample_period_policy: policy,
      },
    });
    expect(
      (studyStageDraftToSceneStage(table).table_autosave as Record<string, unknown>)
        .sample_period_s,
    ).toBeUndefined();
    expect(studyStageDraftToSceneStage(autosave)).toMatchObject({
      output: {
        kind: "field_auto",
        name: "m",
        sample_period_policy: policy,
      },
    });
  });

  it("preserves an unknown table sampling policy losslessly as read-only", () => {
    const stage = {
      enabled: false,
      entrypoint_kind: "flat_table_autosave",
      kind: "table_autosave",
      stage_id: "table-future",
      table_autosave: {
        kind: "table_autosave",
        quantities: ["t", "my"],
        sample_period_policy: { kind: "adaptive_future", tolerance: 0.01 },
        table_id: "future-table",
      },
    };
    const draft = createStudyStageDraft(stage, 0);

    expect(draft.tableAutosave).toMatchObject({
      enabled: false,
      readOnly: true,
      samplingMode: "explicit",
    });
    expect(studyStageDraftToSceneStage(draft)).toEqual(stage);
  });

  it("validates each configuration stage independently while allowing an unsampled Run", () => {
    expect(validateStudyStageDraft(createDefaultStudyStageDraft("run", 0))).toEqual([]);

    const table = createDefaultStudyStageDraft("table_autosave", 0);
    const autosave = createDefaultStudyStageDraft("autosave", 1);
    const fft = createDefaultStudyStageDraft("fft_response", 2);
    expect(validateStudyStageDraft({
      ...table,
      tableAutosave: { ...table.tableAutosave, samplePeriodS: "NaN" },
    }).map((issue) => issue.message)).toContain(
      "Table autosave t_sampling must be a positive finite number.",
    );
    expect(validateStudyStageDraft({
      ...autosave,
      autosave: { ...autosave.autosave, everySeconds: "0" },
    }).map((issue) => issue.message)).toContain(
      "Autosave cadence must be a positive finite number.",
    );
    expect(validateStudyStageDraft({
      ...fft,
      fftResponse: { ...fft.fftResponse, susceptibilityFloorFraction: "1" },
    }).map((issue) => issue.message)).toContain(
      "Susceptibility floor fraction must be in [0, 1).",
    );
  });

  it("migrates legacy nested Run sampling into visible ordered instructions without data loss", () => {
    const drafts = createStudyStageDrafts([
      {
        entrypoint_kind: "flat_run",
        kind: "run",
        sampling: {
          outputs: [
            { every_seconds: 2e-12, kind: "field", name: "m" },
            { every_seconds: 5e-13, kind: "field", name: "H_drive" },
          ],
          table_autosave: {
            kind: "table_autosave",
            quantities: ["t", "mx", "my"],
            sample_period_s: 5e-13,
            table_id: "default",
          },
        },
        spin_wave_response: {
          analysis: "gamma",
          detrend: "linear",
          response_component: "my",
          schema_version: "spin_wave_response.request.v1",
          susceptibility_floor_fraction: 1e-6,
          weighting: "Ms_times_lumped_volume",
          window: "hann",
        },
        stage_id: "legacy-run",
        until_seconds: 2e-9,
      },
    ]);

    expect(drafts.map((draft) => draft.kind)).toEqual([
      "autosave",
      "table_autosave",
      "autosave",
      "autosave",
      "fft_response",
      "run",
    ]);
    expect(drafts[0].autosave).toMatchObject({ clearAll: true, enabled: false });
    expect(drafts[1].tableAutosave).toMatchObject({
      enabled: true,
      samplePeriodS: "5e-13",
    });
    expect(drafts[2].autosave.quantity).toBe("m");
    expect(drafts[3].autosave.quantity).toBe("H_drive");
    expect(drafts[4].fftResponse.enabled).toBe(true);
    expect(studyStageDraftToSceneStage(drafts[5])).toEqual({
      entrypoint_kind: "flat_run",
      kind: "run",
      stage_id: "legacy-run",
      until_seconds: 2e-9,
    });
  });

  it("preserves an unsupported stage losslessly as read-only", () => {
    const stage = {
      kind: "future_solver_action",
      stage_id: "future-1",
      nested: { opaque: [1, 2, 3] },
    };

    const [draft] = createStudyStageDrafts([stage]);

    expect(draft.kind).toBe("unsupported");
    expect(draft.rawStage).toEqual(stage);
    expect(studyStageDraftToSceneStage(draft)).toEqual(stage);
    expect(validateStudyStageDraft(draft)).toContainEqual({
      message: "Unsupported study stage is preserved losslessly and remains read-only.",
      severity: "warning",
    });
  });

  it("preserves an unsupported FFT request losslessly as read-only", () => {
    const request = {
      analysis: "gamma",
      response_component: "my",
      window: "blackman",
    };
    const draft = createStudyStageDraft({
      enabled: true,
      kind: "fft_response",
      request,
      stage_id: "future-fft",
    }, 0);

    expect(draft).toMatchObject({
      fftResponse: {
        rawRequest: request,
        readOnly: true,
      },
      kind: "fft_response",
    });
    expect(studyStageDraftToSceneStage(draft)).toMatchObject({ request });
    expect(validateStudyStageDraft(draft)).toContainEqual({
      message: "Unsupported FFT response request is preserved read-only.",
      severity: "warning",
    });
  });

  it("serializes algorithm-specific canonical relaxation fields", () => {
    const llg = studyStageDraftToSceneStage({
      ...createDefaultStudyStageDraft("relax", 0),
      demagInterval: "2e-12",
      dt: "1e-13",
      energyTolerance: "1e-20",
      maxRelaxationTime: "4e-9",
      solver: "rk45",
      timestepMode: "fixed",
    });
    expect(llg).toMatchObject({
      algorithm: "llg_overdamped",
      demag_interval_s: 2e-12,
      energy_tolerance_j: 1e-20,
      fixed_timestep: 1e-13,
      integrator: "rk45",
      max_relaxation_time_s: 4e-9,
      max_steps: 50000,
      torque_tolerance_apm: 1e-4,
    });

    const direct = studyStageDraftToSceneStage({
      ...createDefaultStudyStageDraft("relax", 0),
      algorithm: "projected_gradient_bb",
      demagInterval: "2e-12",
      dt: "1e-13",
      maxRelaxationTime: "4e-9",
      relaxAlpha: "1",
      solver: "rk45",
    });
    expect(direct).toMatchObject({
      algorithm: "projected_gradient_bb",
      max_steps: 50000,
      torque_tolerance_apm: 1e-4,
    });
    expect(direct).not.toHaveProperty("demag_interval_s");
    expect(direct).not.toHaveProperty("fixed_timestep");
    expect(direct).not.toHaveProperty("integrator");
    expect(direct).not.toHaveProperty("max_relaxation_time_s");
    expect(direct).not.toHaveProperty("relax_alpha");
  });

  it("round-trips canonical LLG relaxation controls", () => {
    const draft = createStudyStageDraft(
      {
        algorithm: "llg_overdamped",
        demag_interval_s: 2e-12,
        energy_tolerance_j: 1e-20,
        fixed_timestep: 1e-13,
        integrator: "rk45",
        kind: "relax",
        max_relaxation_time_s: 4e-9,
        max_steps: 50000,
        stage_id: "relax-1",
        torque_tolerance_apm: 1e-4,
      },
      0,
    );
    expect(draft).toMatchObject({
      demagInterval: "2e-12",
      dt: "1e-13",
      energyTolerance: "1e-20",
      maxRelaxationTime: "4e-9",
      solver: "rk45",
      torqueTolerance: "0.0001",
    });
  });

  it("preserves adaptive timestep mode without converting dt_initial to fixed", () => {
    const draft = createStudyStageDraft(
      {
        adaptive_timestep: {
          atol: 1e-6,
          dt_min: 1e-17,
          dt_max: 1e-13,
          rtol: 0,
          tolerance_mode: "max_error",
        },
        algorithm: "llg_overdamped",
        kind: "relax",
        max_steps: 50000,
        stage_id: "adaptive",
        torque_tolerance_apm: 1e-4,
      },
      0,
    );
    expect(draft).toMatchObject({
      dt: "",
      dtMax: "1e-13",
      dtMin: "1e-17",
      maxError: "0.000001",
      toleranceMode: "max_error",
      timestepMode: "adaptive",
    });
    expect(studyStageDraftToSceneStage(draft)).toMatchObject({
      adaptive_timestep: {
        atol: 1e-6,
        dt_min: 1e-17,
        dt_max: 1e-13,
        rtol: 0,
        tolerance_mode: "max_error",
      },
    });
    expect(
      (studyStageDraftToSceneStage(draft).adaptive_timestep as Record<string, unknown>)
        .dt_initial,
    ).toBeUndefined();
    expect(studyStageDraftToSceneStage(draft)).not.toHaveProperty("fixed_timestep");
  });

  it("keeps omitted adaptive dt_initial valid and rejects incomplete or CUDA FDM execution", () => {
    const draft = createStudyStageDraft(
      {
        adaptive_timestep: {
          atol: 1e-6,
          dt_min: 1e-16,
          dt_max: 1e-13,
          rtol: 0,
          tolerance_mode: "max_error",
        },
        algorithm: "llg_overdamped",
        integrator: "rk45",
        kind: "relax",
        max_steps: 50000,
        stage_id: "adaptive",
        torque_tolerance_apm: 1e-4,
      },
      0,
    );
    expect(draft.dt).toBe("");
    expect(validateStudyStageDraft(draft, {
      algorithmsAvailable: ["llg_overdamped"],
      backend: "fdm",
      device: "cpu",
      mode: "strict",
    }).map((issue) => issue.message)).not.toContain("dt must be finite and positive.");

    const incomplete = { ...draft, dtMax: "" };
    expect(validateStudyStageDraft(incomplete, {
      algorithmsAvailable: ["llg_overdamped"],
      backend: "fdm",
      device: "gpu",
      mode: "strict",
    }).map((issue) => issue.message)).toEqual(expect.arrayContaining([
      "dt_max is required and must be finite and positive.",
      "Adaptive FDM execution requires an explicit CPU device.",
    ]));
  });

  it("preserves advanced adaptive atol and rtol separately", () => {
    const draft = createStudyStageDraft(
      {
        adaptive_timestep: {
          atol: 1e-8,
          dt_initial: 2e-15,
          dt_min: 1e-16,
          dt_max: 1e-13,
          rtol: 1e-5,
          tolerance_mode: "advanced",
        },
        algorithm: "llg_overdamped",
        kind: "relax",
        max_steps: 50000,
        stage_id: "advanced-adaptive",
        torque_tolerance_apm: 1e-4,
      },
      0,
    );
    expect(draft).toMatchObject({
      atol: "1e-8",
      rtol: "0.00001",
      toleranceMode: "advanced",
    });
    expect(studyStageDraftToSceneStage(draft)).toMatchObject({
      adaptive_timestep: {
        atol: 1e-8,
        rtol: 1e-5,
        tolerance_mode: "advanced",
      },
    });
  });

  it("migrates discriminator-less advanced payloads without changing custom controls", () => {
    const draft = createStudyStageDraft(
      {
        adaptive_timestep: {
          atol: 3e-8,
          rtol: 4e-5,
          dt_initial: 2e-15,
          dt_min: 1e-16,
          dt_max: 1e-13,
          safety: 0.75,
          growth_limit: 1.6,
          shrink_limit: 0.35,
          max_spin_rotation: 0.15,
          norm_tolerance: 2e-6,
        },
        algorithm: "llg_overdamped",
        integrator: "rk45",
        kind: "relax",
        max_steps: 50000,
        stage_id: "legacy-advanced",
        torque_tolerance_apm: 1e-4,
      },
      0,
    );

    expect(draft).toMatchObject({
      toleranceMode: "advanced",
      safety: "0.75",
      growthLimit: "1.6",
      shrinkLimit: "0.35",
      maxSpinRotation: "0.15",
      normTolerance: "0.000002",
    });
    expect(studyStageDraftToSceneStage(draft)).toMatchObject({
      adaptive_timestep: {
        tolerance_mode: "advanced",
        atol: 3e-8,
        rtol: 4e-5,
        safety: 0.75,
        growth_limit: 1.6,
        shrink_limit: 0.35,
        max_spin_rotation: 0.15,
        norm_tolerance: 2e-6,
      },
    });
  });

  it("rejects simultaneous fixed and adaptive timestep controls", () => {
    const draft = createStudyStageDraft(
      {
        adaptive_timestep: { atol: 1e-6, dt_initial: 2e-15 },
        algorithm: "llg_overdamped",
        fixed_timestep: 1e-13,
        kind: "relax",
        max_steps: 50000,
        stage_id: "conflict",
        torque_tolerance_apm: 1e-4,
      },
      0,
    );
    expect(validateStudyStageDraft(draft)).toContainEqual({
      message: "Fixed and adaptive timestep controls are mutually exclusive.",
      severity: "error",
    });
  });

  it("rejects an implicit LLG relaxation timestep policy", () => {
    const draft = {
      ...createDefaultStudyStageDraft("relax", 0),
      algorithm: "llg_overdamped",
      solver: "rk45",
      timestepMode: "auto" as const,
    };

    expect(validateStudyStageDraft(draft).map((issue) => issue.message)).toContain(
      "LLG relaxation requires an explicit fixed or adaptive timestep policy.",
    );
  });

  it("gates tangent-plane implicit to the development FEM CPU lane", () => {
    const draft = {
      ...createDefaultStudyStageDraft("relax", 0),
      algorithm: "tangent_plane_implicit",
    };
    expect(
      validateStudyStageDraft(draft, {
        backend: "fem",
        device: "gpu",
        mode: "strict",
      }),
    ).toContainEqual({
      message:
        "Tangent-plane implicit is development-only and requires FEM CPU in extended mode.",
      severity: "error",
    });
    expect(
      validateStudyStageDraft(draft, {
        backend: "fem",
        device: "cpu",
        mode: "extended",
      }),
    ).toEqual([]);
  });

  it("distinguishes unknown capabilities from an explicitly unavailable algorithm", () => {
    const draft = {
      ...createDefaultStudyStageDraft("relax", 0),
      dt: "1e-15",
      timestepMode: "fixed" as const,
    };
    expect(validateStudyStageDraft(draft)).toEqual([]);
    expect(
      validateStudyStageDraft(draft, {
        algorithmsAvailable: [],
        backend: "fdm",
        device: "cpu",
        mode: "strict",
      }),
    ).toContainEqual({
      message:
        "llg_overdamped is not advertised by the active session capabilities.",
      severity: "error",
    });
  });

  it("rejects unavailable K0 periodic-airbox prerequisites", () => {
    const draft = {
      ...createDefaultStudyStageDraft("eigenmodes", 0),
      bc: "periodic", deviceTarget: "gpu", dampingPolicy: "ignore",
      frequencyMax: "2e9", frequencyMin: "1e9", includeDemag: true,
      kVector: "0,0,0", magnetostaticBc: "periodic_airbox_k0", target: "frequency_window",
    };
    const messages = validateStudyStageDraft(draft, {
      acceptedEquilibriumReady: false, backend: "fem", device: "gpu", mode: "strict",
      periodicCertificateReady: false, sharedDomainMeshReady: false, strictGpuReady: false,
    }).map((issue) => issue.message);
    expect(messages).toEqual(expect.arrayContaining([
      "periodic_airbox_k0 requires a shared-domain mesh.",
      "periodic_airbox_k0 requires a periodic certificate.",
      "periodic_airbox_k0 requires an accepted equilibrium.",
      "Strict GPU K0 modal demag prerequisites are unavailable.",
    ]));
  });

  it("uses the requested global GPU intent for K0 strict readiness", () => {
    const draft = {
      ...createDefaultStudyStageDraft("eigenmodes", 0),
      bc: "periodic",
      dampingPolicy: "ignore",
      frequencyMax: "2e9",
      frequencyMin: "1e9",
      includeDemag: true,
      kVector: "0,0,0",
      magnetostaticBc: "periodic_airbox_k0",
      target: "frequency_window",
    };

    expect(
      validateStudyStageDraft(draft, {
        acceptedEquilibriumReady: true,
        backend: "fem",
        device: "gpu",
        mode: "strict",
        periodicCertificateReady: true,
        sharedDomainMeshReady: true,
        strictGpuReady: false,
      }),
    ).toContainEqual({
      message: "Strict GPU K0 modal demag prerequisites are unavailable.",
      severity: "error",
    });
  });

  it("serializes the canonical K0 periodic-airbox demag intent for eigenmodes", () => {
    const stage = studyStageDraftToSceneStage({
      ...createDefaultStudyStageDraft("eigenmodes", 0),
      bc: "periodic",
      dampingPolicy: "ignore",
      includeDemag: true,
      kVector: "0,0,0",
      magnetostaticBc: "periodic_airbox_k0",
      stageId: "k0-modal",
    });

    expect(stage).toMatchObject({
      eigen_magnetostatic_bc: "periodic_airbox_k0",
      include_demag: true,
      magnetostatic_bc: "periodic_airbox_k0",
    });
  });

  it("requires both static and advertised capability for TPI", () => {
    expect(
      relaxationAlgorithmAvailability("tangent_plane_implicit", {
        algorithmsAvailable: ["llg_overdamped"],
        backend: "fem",
        device: "cpu",
        mode: "extended",
      }),
    ).toEqual({
      reason:
        "tangent_plane_implicit is not advertised by the active session capabilities.",
      supported: false,
    });
  });

  it("rejects FEM projected-gradient BB when demag is enabled", () => {
    const execution = {
      algorithmsAvailable: [
        "llg_overdamped",
        "projected_gradient_bb",
        "nonlinear_cg",
      ],
      backend: "fem",
      demagEnabled: true,
      device: "gpu",
      mode: "strict",
    };
    expect(
      relaxationAlgorithmAvailability("projected_gradient_bb", {
        ...execution,
      }),
    ).toEqual({ reason: null, supported: true });
  });
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
      maxRelaxationTime: "5e-9",
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
          target: "nearest",
          target_frequency: 2e9,
        },
        2,
      ),
    ).toMatchObject({
      bc: '{"kind":"periodic","axes":["x"]}',
      count: "12",
      dampingPolicy: "include",
      equilibriumArtifact: "artifact://relaxed",
      equilibriumSource: "provided",
      includeDemag: false,
      kSampling: '{"path":"gamma-x","points":5}',
      kVector: "0, 1, -1",
      kind: "eigenmodes",
      normalization: "unit_max_amplitude",
      stageId: "modes-1",
      target: "nearest",
      targetFrequency: "2000000000",
    });

    expect(
      createStudyStageDraft(
        {
          entrypoint_kind: "pipeline_frequency_response",
          frequency_magnetostatic_bc: "periodic_airbox_k0",
          frequency_excitation_field_au_per_m: [0, -2, 3],
          frequency_excitation_phase_rad: 0.375,
          frequency_observable: "mx",
          frequency_spin_wave_bc: { kind: "periodic", axes: ["x", "y"] },
          frequency_values_hz: [1e9, 2e9],
          kind: "frequency_response",
          stage_id: "freq-1",
        },
        3,
      ),
    ).toMatchObject({
      bc: '{"kind":"periodic","axes":["x","y"]}',
      excitationField: "0, -2, 3",
      excitationPhaseRad: "0.375",
      frequenciesHz: "1000000000, 2000000000",
      kind: "frequency_response",
      magnetostaticBc: "periodic_airbox_k0",
      observable: "mx",
      stageId: "freq-1",
    });

    expect(
      createStudyStageDraft(
        {
          device: "cpu",
          entrypoint_kind: "flat_change_device",
          kind: "change_device",
          stage_id: "device-cpu",
        },
        4,
      ),
    ).toMatchObject({
      deviceTarget: "cpu",
      kind: "change_device",
      stageId: "device-cpu",
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

  it("validates hysteresis field orientation authoring", () => {
    expect(
      validateStudyStageDraft({
        ...createDefaultStudyStageDraft("hysteresis", 0),
        customDirection: "",
        orientationMode: "preset",
      }),
    ).toContainEqual({
      message: "Orientation preset is required.",
      severity: "error",
    });

    expect(
      validateStudyStageDraft({
        ...createDefaultStudyStageDraft("hysteresis", 0),
        customDirection: "diagonal",
        orientationMode: "preset",
      }),
    ).toContainEqual({
      message: "Orientation preset must be oop_positive, oop_negative, in_plane_x, in_plane_y.",
      severity: "error",
    });

    expect(
      validateStudyStageDraft({
        ...createDefaultStudyStageDraft("hysteresis", 0),
        orientationMode: "sample",
        phiDeg: "",
        thetaDeg: "",
      }),
    ).toEqual(
      expect.arrayContaining([
        { message: "Theta is required.", severity: "error" },
        { message: "Phi is required.", severity: "error" },
      ]),
    );

    expect(
      validateStudyStageDraft({
        ...createDefaultStudyStageDraft("hysteresis", 0),
        customDirection: "0, 0, 0",
        orientationMode: "global",
      }),
    ).toContainEqual({
      message: "Orientation vector must not be the zero vector.",
      severity: "error",
    });
  });

  it("validates custom hysteresis measurement axis authoring", () => {
    expect(
      validateStudyStageDraft({
        ...createDefaultStudyStageDraft("hysteresis", 0),
        measurementAxis: "custom",
      }).map((issue) => issue.message),
    ).toContain("Custom measurement axis vector is required.");

    expect(
      validateStudyStageDraft({
        ...createDefaultStudyStageDraft("hysteresis", 0),
        measurementAxis: "custom",
        measurementAxisCustomVector: "0, 0, 0",
      }).map((issue) => issue.message),
    ).toContain("Custom measurement axis vector must not be the zero vector.");

    expect(
      studyStageDraftToSceneStage({
        ...createDefaultStudyStageDraft("hysteresis", 0),
        measurementAxis: "custom",
        measurementAxisCustomVector: "1, 0, 0",
      }).measurement_axis,
    ).toEqual({
      kind: "custom",
      vector: [1, 0, 0],
    });

    expect(
      createStudyStageDraft(
        {
          field_max_mT: 100,
          field_min_mT: -100,
          field_step_mT: 10,
          kind: "hysteresis",
          measurement_axis: {
            kind: "custom",
            vector: [0, 1, 0],
          },
          stage_id: "hysteresis-custom-axis",
        },
        0,
      ),
    ).toMatchObject({
      measurementAxis: "custom",
      measurementAxisCustomVector: "0, 1, 0",
    });
  });

  it("validates hysteresis checkpoint initial state authoring", () => {
    expect(
      validateStudyStageDraft({
        ...createDefaultStudyStageDraft("hysteresis", 0),
        initialStatePolicy: "checkpoint",
      }).map((issue) => issue.message),
    ).toContain("Initial state ref is required for checkpoint starts.");

    expect(
      studyStageDraftToSceneStage({
        ...createDefaultStudyStageDraft("hysteresis", 0),
        initialStatePolicy: "checkpoint",
        initialStateRef: "hysteresis_snapshots/hysteresis_point_003/m.json",
      }),
    ).toMatchObject({
      initial_protocol: "checkpoint",
      initial_state_ref: "hysteresis_snapshots/hysteresis_point_003/m.json",
    });

    expect(
      createStudyStageDraft(
        {
          field_max_mT: 100,
          field_min_mT: -100,
          field_step_mT: 10,
          initial_protocol: "checkpoint",
          initial_state_ref: "hysteresis_snapshots/hysteresis_point_003/m.json",
          kind: "hysteresis",
          stage_id: "hysteresis-checkpoint",
        },
        0,
      ),
    ).toMatchObject({
      initialStatePolicy: "checkpoint",
      initialStateRef: "hysteresis_snapshots/hysteresis_point_003/m.json",
    });
  });

  it("serializes ordered configuration instructions and a simple Run into a study stages merge patch", () => {
    const relax = {
      ...createDefaultStudyStageDraft("relax", 0),
      dt: "auto",
      dtMin: "1e-18",
      energyTolerance: "1e-10",
      fieldEvery: "10",
      maxError: "1e-4",
      maxRelaxationTime: "5e-9",
      maxSteps: "1000",
      relaxAlpha: "0.7",
      solver: "rk45",
      stageId: "relax-1",
      torqueTolerance: "1e-6",
      timestepMode: "adaptive" as const,
    };
    const run = {
      ...createDefaultStudyStageDraft("run", 1),
      stageId: "run-2",
      untilSeconds: "3e-9",
    };
    const table = {
      ...createDefaultStudyStageDraft("table_autosave", 1),
      stageId: "table-on",
    };
    const autosave = {
      ...createDefaultStudyStageDraft("autosave", 2),
      stageId: "autosave-m",
    };
    const fft = {
      ...createDefaultStudyStageDraft("fft_response", 3),
      stageId: "fft-on",
    };

    expect(buildStudyStagesMergePatch([relax, table, autosave, fft, run])).toEqual({
      kind: "merge_patch",
      merge_patch: {
        study: {
          stages: [
            {
              algorithm: "llg_overdamped",
              adaptive_timestep: {
                atol: 1e-4,
                dt_min: 1e-18,
                rtol: 0,
                tolerance_mode: "max_error",
              },
              energy_tolerance_j: 1e-10,
              entrypoint_kind: "flat_relax",
              field_refresh: { every_n: 10 },
              integrator: "rk45",
              kind: "relax",
              max_relaxation_time_s: 5e-9,
              max_steps: 1000,
              relax_alpha: 0.7,
              stage_id: "relax-1",
              torque_tolerance_apm: 1e-6,
            },
            {
              enabled: true,
              entrypoint_kind: "flat_table_autosave",
              kind: "table_autosave",
              stage_id: "table-on",
              table_autosave: {
                kind: "table_autosave",
                quantities: ["t", "step", "mx", "my", "mz", "e_drive"],
                sample_period_s: 5e-13,
                table_id: "default",
              },
            },
            {
              enabled: true,
              entrypoint_kind: "flat_autosave",
              kind: "autosave",
              output: { every_seconds: 2e-12, kind: "field", name: "m" },
              quantity: "m",
              stage_id: "autosave-m",
            },
            {
              enabled: true,
              entrypoint_kind: "flat_fft_response",
              kind: "fft_response",
              request: {
                analysis: "gamma",
                detrend: "linear",
                response_component: "my",
                schema_version: "spin_wave_response.request.v1",
                susceptibility_floor_fraction: 1e-6,
                weighting: "Ms_times_lumped_volume",
                window: "hann",
              },
              stage_id: "fft-on",
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

  it("carries the scene revision when saving a newly authored Relax stage", () => {
    const relax = createDefaultStudyStageDraft("relax", 0);

    expect(buildStudyStagesMergePatch([relax], 17)).toMatchObject({
      kind: "merge_patch",
      base_revision: 17,
      merge_patch: { study: { stages: [{ kind: "relax" }] } },
    });
  });

  it("serializes fixed relax dt as a numeric timestep", () => {
    expect(
      studyStageDraftToSceneStage({
        ...createDefaultStudyStageDraft("relax", 0),
        dt: "5e-15",
        timestepMode: "fixed",
      }),
    ).toMatchObject({
      fixed_timestep: 5e-15,
    });
  });

  it("serializes spectral authoring options with Python DSL vocabulary", () => {
    expect(
      studyStageDraftToSceneStage({
        ...createDefaultStudyStageDraft("eigenmodes", 0),
        calculationMode: "dispersion_modal",
        dampingPolicy: "include",
        equilibriumSource: "artifact",
        normalization: "unit_max_amplitude",
        stageId: "modes-1",
      }),
    ).toMatchObject({
      calculation_mode: "dispersion_modal",
      damping_policy: "include",
      eigen_calculation_mode: "dispersion_modal",
      eigen_damping_policy: "include",
      eigen_equilibrium_source: "artifact",
      eigen_normalization: "unit_max_amplitude",
      equilibrium_source: "artifact",
      normalization: "unit_max_amplitude",
    });
  });

  it("round-trips eigenmode k-path text for Python dispersion authoring", () => {
    const kPath = "G:0,0,0; X:1e7,0,0; G:0,0,0 | samples=2,2";
    const draft = createStudyStageDraft(
      {
        eigen_count: 3,
        eigen_frequency_max: 2.5e9,
        eigen_frequency_min: 1.5e9,
        eigen_k_path: kPath,
        eigen_operator: "full_2x2",
        eigen_target: "frequency_window",
        kind: "eigenmodes",
        stage_id: "dispersion-1",
      },
      0,
    );

    expect(draft).toMatchObject({
      count: "3",
      frequencyMax: "2500000000",
      frequencyMin: "1500000000",
      kPath,
      kind: "eigenmodes",
      target: "frequency_window",
    });
    expect(studyStageDraftToSceneStage(draft)).toMatchObject({
      eigen_count: 3,
      eigen_frequency_max: 2.5e9,
      eigen_frequency_min: 1.5e9,
      eigen_k_path: kPath,
      eigen_operator: "full_2x2",
      eigen_target: "frequency_window",
    });
  });

  it("serializes eigenmodes, frequency response, and save-state stages", () => {
    expect(
      studyStageDraftToSceneStage({
        ...createDefaultStudyStageDraft("eigenmodes", 0),
        bc: '{"kind":"periodic","axes":["x"]}',
        count: "4",
        dampingPolicy: "include",
        equilibriumArtifact: "artifact://relaxed",
        equilibriumSource: "provided",
        includeDemag: false,
        kSampling: '{"points":5}',
        kVector: "0, 1, -1",
        normalization: "unit_max_amplitude",
        stageId: "modes-1",
        target: "nearest",
        targetFrequency: "2e9",
      }),
    ).toEqual({
      bc: { axes: ["x"], kind: "periodic" },
      calculation_mode: "fmr_modal",
      count: 4,
      damping_policy: "include",
      eigen_calculation_mode: "fmr_modal",
      eigen_count: 4,
      eigen_damping_policy: "include",
      eigen_equilibrium_artifact: "artifact://relaxed",
      eigen_equilibrium_source: "provided",
      eigen_include_demag: false,
      eigen_k_sampling: { points: 5 },
      eigen_k_vector: [0, 1, -1],
      eigen_magnetostatic_bc: "open",
      eigen_normalization: "unit_max_amplitude",
      eigen_operator: "linearized_llg",
      eigen_spin_wave_bc: { axes: ["x"], kind: "periodic" },
      eigen_target: "nearest",
      eigen_target_frequency: 2e9,
      equilibrium_artifact: "artifact://relaxed",
      equilibrium_source: "provided",
      entrypoint_kind: "flat_eigenmodes",
      include_demag: false,
      k_sampling: { points: 5 },
      k_vector: [0, 1, -1],
      magnetostatic_bc: "open",
      kind: "eigenmodes",
      normalization: "unit_max_amplitude",
      operator: "linearized_llg",
      stage_id: "modes-1",
      target: "nearest",
      target_frequency: 2e9,
    });

    expect(
      studyStageDraftToSceneStage({
        ...createDefaultStudyStageDraft("frequency_response", 1),
        bc: '{"kind":"periodic","axes":["x","y"]}',
        excitationField: "0, -2, 3",
        excitationPhaseRad: "0.375",
        frequenciesHz: "1e9, 2e9",
        magnetostaticBc: "periodic_airbox_k0",
        observable: "mx",
        solverMethod: "gpu_operator_host_krylov",
        stageId: "freq-1",
      }),
    ).toMatchObject({
      bc: { axes: ["x", "y"], kind: "periodic" },
      entrypoint_kind: "flat_frequency_response",
      excitation_field_au_per_m: [0, -2, 3],
      excitation_phase_rad: 0.375,
      frequency_excitation_field_au_per_m: [0, -2, 3],
      frequency_excitation_phase_rad: 0.375,
      frequency_magnetostatic_bc: "periodic_airbox_k0",
      frequency_observable: "mx",
      frequency_solver_method: "gpu_operator_host_krylov",
      frequency_spin_wave_bc: { axes: ["x", "y"], kind: "periodic" },
      frequency_values_hz: [1e9, 2e9],
      frequencies_hz: [1e9, 2e9],
      kind: "frequency_response",
      magnetostatic_bc: "periodic_airbox_k0",
      observable: "mx",
      solver_method: "gpu_operator_host_krylov",
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

    expect(
      studyStageDraftToSceneStage({
        ...createDefaultStudyStageDraft("change_device", 3),
        deviceTarget: "cpu",
        stageId: "device-cpu",
      }),
    ).toEqual({
      device: "cpu",
      entrypoint_kind: "flat_change_device",
      kind: "change_device",
      stage_id: "device-cpu",
    });
  });

  it("validates change-device stage requests", () => {
    expect(
      validateStudyStageDraft({
        ...createDefaultStudyStageDraft("change_device", 0),
        deviceTarget: "cuda:0",
      }),
    ).toEqual([]);

    expect(
      validateStudyStageDraft({
        ...createDefaultStudyStageDraft("change_device", 0),
        deviceTarget: "tpu",
      }).map((issue) => issue.message),
    ).toContain("Device must be cpu, gpu, cuda, cuda:<index>, or auto.");
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

  it("rejects spectral options outside the Python DSL vocabulary", () => {
    expect(
      validateStudyStageDraft({
        ...createDefaultStudyStageDraft("eigenmodes", 0),
        calculationMode: "response_map",
        dampingPolicy: "linearized",
        equilibriumSource: "current_state",
        normalization: "max_component",
      }).map((issue) => issue.message),
    ).toEqual([
      "Calculation mode must be fmr_modal, free_modes, or dispersion_modal.",
      "Normalization must be unit_l2 or unit_max_amplitude.",
      "Damping policy must be ignore or include.",
      "Equilibrium source must be provided, relax, or artifact.",
    ]);
  });

  it("serializes frequency-response calculation mode intent", () => {
    expect(
      studyStageDraftToSceneStage({
        ...createDefaultStudyStageDraft("frequency_response", 0),
        calculationMode: "response_map",
        frequenciesHz: "1e9",
        stageId: "response-1",
      }),
    ).toMatchObject({
      calculation_mode: "response_map",
      frequency_calculation_mode: "response_map",
      kind: "frequency_response",
    });
  });

  it("validates required positive stage fields", () => {
    expect(
      validateStudyStageDraft({
        ...createDefaultStudyStageDraft("relax", 0),
        maxSteps: "0",
        stageId: "",
        dt: "1e-15",
        timestepMode: "fixed",
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

  it("validates simple hysteresis field range and point count", () => {
    expect(
      validateStudyStageDraft({
        ...createDefaultStudyStageDraft("hysteresis", 0),
        fieldMaxMt: "100",
        fieldMinMt: "100",
      }).map((issue) => issue.message),
    ).toContain("Minimum field and maximum field must differ.");

    expect(
      validateStudyStageDraft({
        ...createDefaultStudyStageDraft("hysteresis", 0),
        fieldMaxMt: "-100",
        fieldMinMt: "100",
      }).map((issue) => issue.message),
    ).toContain("Maximum field must be greater than minimum field.");

    expect(
      validateStudyStageDraft({
        ...createDefaultStudyStageDraft("hysteresis", 0),
        fieldMaxMt: "100",
        fieldMinMt: "-100",
        fieldStepMt: "0.01",
      }).map((issue) => issue.message),
    ).toContain(
      "Simple field schedule has 40001 points; reduce the range, increase the step, or use explicit piecewise segments.",
    );
  });

  it("validates hysteresis saturation probe thresholds", () => {
    expect(
      validateStudyStageDraft({
        ...createDefaultStudyStageDraft("hysteresis", 0),
        saturationMode: "auto",
        saturationThresholds: "1e-3",
      }).map((issue) => issue.message),
    ).toContain(
      "Saturation thresholds must contain susceptibility and transverse thresholds.",
    );

    expect(
      validateStudyStageDraft({
        ...createDefaultStudyStageDraft("hysteresis", 0),
        saturationMode: "auto",
        saturationThresholds: "bad, 1e-2",
      }).map((issue) => issue.message),
    ).toContain(
      "Saturation thresholds must contain susceptibility and transverse thresholds.",
    );

    expect(
      validateStudyStageDraft({
        ...createDefaultStudyStageDraft("hysteresis", 0),
        saturationMode: "auto",
        saturationThresholds: "-1e-3, 0",
      }).map((issue) => issue.message),
    ).toEqual([
      "Saturation susceptibility threshold must be a positive finite number.",
      "Saturation transverse threshold must be a positive finite number.",
    ]);

    expect(
      validateStudyStageDraft({
        ...createDefaultStudyStageDraft("hysteresis", 0),
        saturationMode: "auto",
        saturationThresholds: "1e-3, 1e-2",
      }).map((issue) => issue.message),
    ).not.toContain(
      "Saturation thresholds must contain susceptibility and transverse thresholds.",
    );
  });

  it("requires acknowledgement for every-step hysteresis magnetization storage", () => {
    const draft = {
      ...createDefaultStudyStageDraft("hysteresis", 0),
      storagePolicy: JSON.stringify({
        magnetization: "every_step",
        scalar_history: true,
      }),
    };

    expect(
      validateStudyStageDraft(draft).map((issue) => issue.message),
    ).toContain(
      "Every-step magnetization storage requires storage estimate acknowledgement.",
    );

    const acknowledged = {
      ...draft,
      storageEstimateAcknowledged: true,
    };
    expect(
      validateStudyStageDraft(acknowledged).map((issue) => issue.message),
    ).not.toContain(
      "Every-step magnetization storage requires storage estimate acknowledgement.",
    );
    expect(studyStageDraftToSceneStage(acknowledged)).toMatchObject({
      storage: {
        magnetization: "every_step",
        scalar_history: true,
      },
    });
    expect(studyStageDraftToSceneStage(acknowledged).storage).not.toHaveProperty(
      "storage_estimate_acknowledged",
    );
  });

  it("validates hysteresis storage policy semantics", () => {
    expect(
      validateStudyStageDraft({
        ...createDefaultStudyStageDraft("hysteresis", 0),
        storagePolicy: JSON.stringify({
          every_n: 0,
          key_event_threshold_dm: -0.1,
          magnetization: "selected",
        }),
      }).map((issue) => issue.message),
    ).toEqual([
      "Storage policy every_n must be positive when magnetization is selected or every_n.",
      "Storage policy key_event_threshold_dm must be a positive finite number.",
    ]);

    expect(
      validateStudyStageDraft({
        ...createDefaultStudyStageDraft("hysteresis", 0),
        storagePolicy: JSON.stringify({
          every_n: -1,
          magnetization: "unknown",
        }),
      }).map((issue) => issue.message),
    ).toEqual([
      "Storage policy magnetization must be none, selected, every_n, every_step, or key_events.",
      "Storage policy every_n must be a non-negative integer.",
    ]);

    expect(
      validateStudyStageDraft({
        ...createDefaultStudyStageDraft("hysteresis", 0),
        storagePolicy: JSON.stringify({
          key_event_threshold_dm: 0.02,
          magnetization: "none",
        }),
      }).map((issue) => issue.message),
    ).not.toContain(
      "Storage policy every_n must be positive when magnetization is selected or every_n.",
    );
  });

  it("validates hysteresis settle pipeline step semantics", () => {
    expect(
      validateStudyStageDraft({
        ...createDefaultStudyStageDraft("hysteresis", 0),
        settleSteps: "[]",
      }).map((issue) => issue.message),
    ).toContain("Settle pipeline requires at least one step.");

    expect(
      validateStudyStageDraft({
        ...createDefaultStudyStageDraft("hysteresis", 0),
        settleSteps: JSON.stringify([
          {
            alpha: 0,
            dt_min: 2e-12,
            kind: "relax",
            max_steps: 0,
            method: "unknown_method",
            on_non_convergence: "retry_with_smaller_dt",
            timestep_s: 1e-12,
            torque_tolerance: -1,
          },
        ]),
      }).map((issue) => issue.message),
    ).toEqual([
      "Settle step 1 method is not supported for relax.",
      "Settle step 1 max_steps must be a positive integer.",
      "Settle step 1 alpha must be a positive finite number.",
      "Settle step 1 torque_tolerance must be a positive finite number.",
      "Settle step 1 retry_with_smaller_dt requires retry_timestep_scale.",
      "Settle step 1 dt_min must be smaller than or equal to timestep_s.",
    ]);

    expect(
      validateStudyStageDraft({
        ...createDefaultStudyStageDraft("hysteresis", 0),
        settleSteps: JSON.stringify([
          {
            energy_tolerance: 1e-20,
            kind: "minimize",
            max_steps: 100,
            method: "projected_gradient_bb",
            on_non_convergence: "run_next_algorithm",
            torque_tolerance: 1e-5,
          },
        ]),
      }).map((issue) => issue.message),
    ).toContain("Settle step 1 run_next_algorithm requires a following step.");
  });

  it("serializes UI-authored hysteresis relax-minimize settle algorithms", () => {
    const stage = studyStageDraftToSceneStage({
      ...createDefaultStudyStageDraft("hysteresis", 0),
      settleSteps: JSON.stringify([
        {
          alpha: 0.8,
          kind: "relax",
          max_steps: 50,
          method: "llg_overdamped",
          on_non_convergence: "continue_with_warning",
          torque_tolerance: 1e-6,
        },
        {
          energy_tolerance: 1e-20,
          kind: "minimize",
          max_steps: 200,
          method: "projected_gradient_bb",
          on_non_convergence: "fail_stage",
          torque_tolerance: 1e-5,
        },
      ]),
    });

    expect(stage.settle_pipeline).toEqual({
      kind: "sequence",
      steps: [
        {
          alpha: 0.8,
          kind: "relax",
          max_steps: 50,
          method: "llg_overdamped",
          on_non_convergence: "continue_with_warning",
          torque_tolerance: 1e-6,
        },
        {
          energy_tolerance: 1e-20,
          kind: "minimize",
          max_steps: 200,
          method: "projected_gradient_bb",
          on_non_convergence: "fail_stage",
          torque_tolerance: 1e-5,
        },
      ],
    });
  });

  it("serializes UI-authored hysteresis dynamics retry and applies_to settings", () => {
    const settleSteps = [
      {
        applies_to: "major",
        damping: 0.5,
        kind: "dynamics_settle",
        max_steps: 25,
        method: "heun_dynamics_settle",
        on_non_convergence: "retry_with_smaller_dt",
        retry_max_attempts: 3,
        retry_timestep_scale: 0.5,
        step_id: "field-dynamics",
        stop_criteria: {
          max_torque_T: 1e-4,
        },
        timestep_s: 1e-12,
      },
    ];
    const stage = studyStageDraftToSceneStage({
      ...createDefaultStudyStageDraft("hysteresis", 0),
      protocolKind: "major_loop",
      settleSteps: JSON.stringify(settleSteps),
    });

    expect(stage.settle_pipeline).toEqual({
      kind: "sequence",
      steps: settleSteps,
    });
    expect(validateStudyStageDraft({
      ...createDefaultStudyStageDraft("hysteresis", 0),
      protocolKind: "major_loop",
      settleSteps: JSON.stringify(settleSteps),
    })).toEqual([]);
  });

  it("validates hysteresis settle pipeline fallback topology", () => {
    const missingFallback = validateStudyStageDraft({
      ...createDefaultStudyStageDraft("hysteresis", 0),
      settlePipelineMode: "tree",
      settleBranches: "[]",
      settleSteps: JSON.stringify([
        {
          energy_tolerance: 1e-20,
          kind: "minimize",
          max_steps: 100,
          method: "projected_gradient_bb",
          on_non_convergence: "run_next_algorithm",
          torque_tolerance: 1e-5,
        },
      ]),
    }).map((issue) => issue.message);
    expect(missingFallback).toContain(
      "Settle tree run_next_algorithm requires a non_converged fallback branch.",
    );

    const withFallback = validateStudyStageDraft({
      ...createDefaultStudyStageDraft("hysteresis", 0),
      settlePipelineMode: "tree",
      settleBranches: JSON.stringify([
        {
          run: {
            alpha: 1,
            kind: "relax",
            max_steps: 100,
            method: "llg_overdamped",
            on_non_convergence: "continue_with_warning",
            torque_tolerance: 1e-5,
          },
          when: "non_converged",
        },
      ]),
      settleSteps: JSON.stringify([
        {
          energy_tolerance: 1e-20,
          kind: "minimize",
          max_steps: 100,
          method: "projected_gradient_bb",
          on_non_convergence: "run_next_algorithm",
          torque_tolerance: 1e-5,
        },
      ]),
    }).map((issue) => issue.message);
    expect(withFallback).not.toContain(
      "Settle tree run_next_algorithm requires a non_converged fallback branch.",
    );
  });

  it("validates hysteresis settle pipeline applies_to roles and branch selectors", () => {
    const messages = validateStudyStageDraft({
      ...createDefaultStudyStageDraft("hysteresis", 0),
      settleSteps: JSON.stringify([
        {
          alpha: 1,
          applies_to: ["minor", "recoil", "branch_id"],
          kind: "relax",
          max_steps: 100,
          method: "llg_overdamped",
          on_non_convergence: "continue_with_warning",
          torque_tolerance: 1e-5,
        },
        {
          alpha: 1,
          applies_to: {
            branch_id: "missing_branch",
            kind: "branch_id",
          },
          kind: "relax",
          max_steps: 100,
          method: "llg_overdamped",
          on_non_convergence: "continue_with_warning",
          torque_tolerance: 1e-5,
        },
        {
          alpha: 1,
          applies_to: {
            kind: "point_selector",
          },
          kind: "relax",
          max_steps: 100,
          method: "llg_overdamped",
          on_non_convergence: "continue_with_warning",
          torque_tolerance: 1e-5,
        },
      ]),
    }).map((issue) => issue.message);

    expect(messages).toContain(
      "Settle step 1 applies_to role 'minor' does not exist for this hysteresis protocol.",
    );
    expect(messages).toContain(
      "Settle step 1 applies_to role 'recoil' does not exist for this hysteresis protocol.",
    );
    expect(messages).toContain(
      "Settle step 1 applies_to 'branch_id' requires a selector object.",
    );
    expect(messages).toContain(
      "Settle step 2 applies_to branch_id 'missing_branch' does not exist for this hysteresis protocol.",
    );
    expect(messages).toContain(
      "Settle step 3 applies_to point_selector requires selector object.",
    );
  });

  it("accepts hysteresis settle pipeline applies_to selectors for existing roles", () => {
    const messages = validateStudyStageDraft({
      ...createDefaultStudyStageDraft("hysteresis", 0),
      minorLoops: JSON.stringify([
        {
          returnMt: -25,
          reversalMt: 25,
        },
      ]),
      protocolKind: "major_with_minor_loops",
      settleSteps: JSON.stringify([
        {
          alpha: 1,
          applies_to: ["major", "minor", "key_events"],
          kind: "relax",
          max_steps: 100,
          method: "llg_overdamped",
          on_non_convergence: "continue_with_warning",
          torque_tolerance: 1e-5,
        },
        {
          alpha: 1,
          applies_to: {
            branch_id: "descending",
            kind: "branch_id",
          },
          kind: "relax",
          max_steps: 100,
          method: "llg_overdamped",
          on_non_convergence: "continue_with_warning",
          torque_tolerance: 1e-5,
        },
      ]),
    }).map((issue) => issue.message);

    expect(messages).not.toContain(
      "Settle step 1 applies_to role 'minor' does not exist for this hysteresis protocol.",
    );
    expect(messages).not.toContain(
      "Settle step 2 applies_to branch_id 'descending' does not exist for this hysteresis protocol.",
    );
  });

  it("accepts direct minimizer methods in hysteresis settle pipeline authoring", () => {
    const draft = {
      ...createDefaultStudyStageDraft("hysteresis", 0),
      settleSteps: JSON.stringify([
        {
          energy_tolerance: 1e-20,
          kind: "minimize",
          max_steps: 100,
          method: "nonlinear_cg",
          on_non_convergence: "run_next_algorithm",
          torque_tolerance: 1e-5,
        },
        {
          energy_tolerance: 1e-20,
          kind: "minimize",
          max_steps: 100,
          method: "tangent_plane_implicit",
          on_non_convergence: "continue_with_warning",
          torque_tolerance: 1e-5,
        },
      ]),
    };

    const messages = validateStudyStageDraft(draft).map((issue) => issue.message);

    expect(messages).not.toContain("Settle step 1 method is not supported for minimize.");
    expect(messages).not.toContain("Settle step 2 method is not supported for minimize.");
    expect(studyStageDraftToSceneStage(draft)).toMatchObject({
      settle_pipeline: {
        steps: [
          {
            kind: "minimize",
            method: "nonlinear_cg",
          },
          {
            kind: "minimize",
            method: "tangent_plane_implicit",
          },
        ],
      },
    });
  });

  it("preserves additional tree default steps as always branches", () => {
    expect(
      studyStageDraftToSceneStage({
        ...createDefaultStudyStageDraft("hysteresis", 0),
        settleBranches: JSON.stringify([
          {
            run: {
              alpha: 1,
              kind: "relax",
              max_steps: 300,
              method: "llg_overdamped",
              on_non_convergence: "continue_with_warning",
              torque_tolerance: 1e-6,
            },
            when: "non_converged",
          },
        ]),
        settlePipelineMode: "tree",
        settleSteps: JSON.stringify([
          {
            energy_tolerance: 1e-20,
            kind: "minimize",
            max_steps: 100,
            method: "projected_gradient_bb",
            on_non_convergence: "run_next_algorithm",
            torque_tolerance: 1e-5,
          },
          {
            alpha: 1,
            kind: "relax",
            max_steps: 200,
            method: "llg_overdamped",
            on_non_convergence: "continue_with_warning",
            torque_tolerance: 1e-6,
          },
        ]),
      }),
    ).toMatchObject({
      settle_pipeline: {
        branches: [
          {
            run: {
              kind: "relax",
              max_steps: 200,
              method: "llg_overdamped",
            },
            when: "always",
          },
          {
            run: {
              kind: "relax",
              max_steps: 300,
              method: "llg_overdamped",
            },
            when: "non_converged",
          },
        ],
        default: {
          kind: "minimize",
          method: "projected_gradient_bb",
        },
        kind: "tree",
      },
    });
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

  it("warns about hysteresis piecewise field schedule gaps and ambiguous shared boundaries", () => {
    expect(
      validateStudyStageDraft({
        ...createDefaultStudyStageDraft("hysteresis", 0),
        fieldScheduleMode: "piecewise",
        fieldSegments: JSON.stringify([
          {
            endpointPolicy: "include_stop",
            segmentId: "coarse_start",
            startField: 100,
            step: 50,
            stopField: 20,
          },
          {
            endpointPolicy: "include_stop",
            segmentId: "dense_after_remanence",
            startField: 20,
            step: 5,
            stopField: -5,
          },
          {
            endpointPolicy: "skip_start",
            segmentId: "negative_branch",
            startField: -10,
            step: 25,
            stopField: -100,
          },
        ]),
      }).map((issue) => issue.message),
    ).toEqual([
      "Field segment 2 shares a boundary with segment 1; choose skip_start or include_both explicitly.",
      "Field segment 3 starts at -10 mT, leaving a discontinuity after segment 2 stops at -5 mT.",
    ]);
  });

  it("validates overlapping hysteresis dense windows require distinct priorities", () => {
    expect(
      validateStudyStageDraft({
        ...createDefaultStudyStageDraft("hysteresis", 0),
        denseWindows: JSON.stringify([
          {
            centerMt: 0,
            halfWidthMt: 25,
            reason: "remanence",
            stepMt: 1,
          },
          {
            centerMt: 10,
            halfWidthMt: 25,
            priority: 1,
            reason: "coercive",
            stepMt: 1,
          },
        ]),
      }).map((issue) => issue.message),
    ).toEqual([
      "Dense window 2 overlaps dense window 1; overlapping windows require explicit priority.",
    ]);

    expect(
      validateStudyStageDraft({
        ...createDefaultStudyStageDraft("hysteresis", 0),
        denseWindows: JSON.stringify([
          {
            centerMt: 0,
            halfWidthMt: 25,
            priority: 1,
            reason: "remanence",
            stepMt: 1,
          },
          {
            centerMt: 10,
            halfWidthMt: 25,
            priority: 1,
            reason: "coercive",
            stepMt: 1,
          },
        ]),
      }).map((issue) => issue.message),
    ).toEqual([
      "Dense window 2 overlaps dense window 1; overlapping windows require distinct priority values.",
    ]);
  });

  it("validates hysteresis minor loops against major-loop branch range", () => {
    expect(
      validateStudyStageDraft({
        ...createDefaultStudyStageDraft("hysteresis", 0),
        fieldMaxMt: "100",
        fieldMinMt: "-100",
        minorLoops: JSON.stringify([
          {
            returnMt: 25,
            reversalMt: 25,
          },
          {
            returnMt: -125,
            reversalMt: 125,
          },
        ]),
        protocolKind: "major_loop",
      }).map((issue) => issue.message),
    ).toEqual([
      "Minor loop 1 reversal_mT and return_mT must differ.",
      "Minor loops require branch mode major_with_minor_loops.",
      "Minor loop 2 reversal_mT must be within the field range.",
      "Minor loop 2 return_mT must be within the field range.",
    ]);
  });

  it("accepts a hysteresis minor loop inside a major-with-minor-loops branch", () => {
    const messages = validateStudyStageDraft({
      ...createDefaultStudyStageDraft("hysteresis", 0),
      fieldMaxMt: "100",
      fieldMinMt: "-100",
      minorLoops: JSON.stringify([
        {
          returnMt: -50,
          reversalMt: 50,
        },
      ]),
      protocolKind: "major_with_minor_loops",
    }).map((issue) => issue.message);

    expect(messages).not.toContain(
      "Minor loops require branch mode major_with_minor_loops.",
    );
    expect(messages).not.toContain(
      "Minor loop 1 reversal_mT must be within the field range.",
    );
    expect(messages).not.toContain(
      "Minor loop 1 return_mT must be within the field range.",
    );
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
