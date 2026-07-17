import { describe, expect, it } from "vitest";

import {
  buildStudyGlobalMergePatch,
  createStudyGlobalDraft,
  validateStudyGlobalDraft,
} from "./StudyGlobalAuthoringModel";

describe("StudyGlobalAuthoringModel", () => {
  it("creates a global study draft from scene study settings", () => {
    expect(
      createStudyGlobalDraft({
        study: {
          demag_enabled: false,
          demag_realization: "poisson_robin",
          exchange_enabled: false,
          external_field: [0.1, 0.2, 0.3],
          fem_demag_solver_policy: { linear_solver: "cg", tolerance: 1e-8 },
          requested_backend: "fem",
          requested_cpu_threads: 8,
          requested_device: "gpu",
          requested_mode: "extended",
          requested_precision: "single",
          solver: { integrator: "rk45" },
        },
      }),
    ).toEqual({
      demagEnabled: false,
      demagRealization: "poisson_robin",
      exchangeEnabled: false,
      externalField: "0.1, 0.2, 0.3",
      femDemagSolverPolicy: '{"linear_solver":"cg","tolerance":1e-8}',
      requestedBackend: "fem",
      requestedCpuThreads: "8",
      requestedDevice: "gpu",
      requestedMode: "extended",
      requestedPrecision: "single",
      solver: {
        adaptiveTimestep: null,
        demagInterval: "",
        dtInitial: "",
        dtMax: "",
        dtMin: "",
        energyTolerance: "",
        fixDt: "",
        integrator: "rk45",
        maxErr: "",
        maxRelaxSteps: "",
        relaxAlgorithm: "",
        timestepMode: "auto",
        torqueTolerance: "",
      },
    });
  });

  it("serializes global study settings into a model merge patch", () => {
    expect(
      buildStudyGlobalMergePatch({
        demagEnabled: true,
        demagRealization: "fredkin_koehler",
        exchangeEnabled: true,
        externalField: "1e-3, 0, -2e-3",
        femDemagSolverPolicy: '{"linear_solver":"cg"}',
        requestedBackend: "fem",
        requestedCpuThreads: "12",
        requestedDevice: "gpu",
        requestedMode: "strict",
        requestedPrecision: "double",
        solver: {
          adaptiveTimestep: null,
          demagInterval: "",
          dtInitial: "",
          dtMax: "",
          dtMin: "1e-16",
          energyTolerance: "",
          fixDt: "",
          integrator: "rk45",
          maxErr: "1e-6",
          maxRelaxSteps: "5000",
          relaxAlgorithm: "llg_overdamped",
          timestepMode: "adaptive_max_error",
          torqueTolerance: "1e-4",
        },
      }),
    ).toEqual({
      kind: "merge_patch",
      merge_patch: {
        study: {
          demag_enabled: true,
          demag_realization: "fredkin_koehler",
          exchange_enabled: true,
          external_field: [1e-3, 0, -2e-3],
          fem_demag_solver_policy: { linear_solver: "cg" },
          requested_backend: "fem",
          requested_cpu_threads: 12,
          requested_device: "gpu",
          requested_mode: "strict",
          requested_precision: "double",
          solver: {
            adaptive_timestep: null,
            demag_interval_s: null,
            dt_initial: null,
            dt_max: null,
            dt_min: 1e-16,
            fixed_timestep: null,
            integrator: "rk45",
            max_err: 1e-6,
            max_relax_steps: "5000",
            relax_algorithm: "llg_overdamped",
            torque_tolerance: "1e-4",
            energy_tolerance: "",
          },
        },
      },
    });
  });

  it("serializes blank optional global fields as null merge-patch removals", () => {
    const request = buildStudyGlobalMergePatch({
      demagEnabled: true,
      demagRealization: "auto",
      exchangeEnabled: true,
      externalField: "",
      femDemagSolverPolicy: "",
      requestedBackend: "auto",
      requestedCpuThreads: "",
      requestedDevice: "auto",
      requestedMode: "strict",
      requestedPrecision: "double",
      solver: {
        adaptiveTimestep: null,
        demagInterval: "",
        dtInitial: "",
        dtMax: "",
        dtMin: "",
        energyTolerance: "",
        fixDt: "",
        integrator: "",
        maxErr: "",
        maxRelaxSteps: "",
        relaxAlgorithm: "",
        timestepMode: "auto",
        torqueTolerance: "",
      },
    });
    expect(request.kind).toBe("merge_patch");
    if (request.kind !== "merge_patch") throw new Error("expected merge patch");

    expect(request.merge_patch.study).toMatchObject({
      external_field: null,
      fem_demag_solver_policy: null,
      requested_cpu_threads: null,
      solver: {},
    });
  });

  it("round-trips advanced adaptive tolerances without synthesizing dt_initial", () => {
    const draft = createStudyGlobalDraft({
      study: {
        solver: {
          adaptive_timestep: {
            atol: 1e-8,
            rtol: 1e-5,
            dt_initial: "",
            dt_min: 1e-16,
            dt_max: 1e-13,
            safety: 0.9,
            growth_limit: 2,
            shrink_limit: 0.2,
            max_spin_rotation: "",
            norm_tolerance: "",
          },
          integrator: "rk45",
        },
      },
    });
    expect(draft.solver).toMatchObject({
      integrator: "rk45",
      timestepMode: "adaptive_advanced",
      adaptiveTimestep: {
        atol: "1e-8",
        rtol: "0.00001",
        dtInitial: "",
        dtMax: "1e-13",
        dtMin: "1e-16",
      },
    });
    const request = buildStudyGlobalMergePatch(draft);
    expect(request.kind).toBe("merge_patch");
    if (request.kind !== "merge_patch") throw new Error("expected merge patch");
    expect(request.merge_patch.study).toMatchObject({
      solver: {
        adaptive_timestep: {
          atol: 1e-8,
          rtol: 1e-5,
          dt_initial: null,
          dt_min: 1e-16,
          dt_max: 1e-13,
        },
      },
    });
  });

  it("validates global vector and CPU thread fields", () => {
    expect(
      validateStudyGlobalDraft({
        demagEnabled: true,
        demagRealization: "auto",
        exchangeEnabled: true,
        externalField: "1, 2",
        femDemagSolverPolicy: "[]",
        requestedBackend: "",
        requestedCpuThreads: "0",
        requestedDevice: "auto",
        requestedMode: "strict",
        requestedPrecision: "double",
      solver: {
        adaptiveTimestep: null,
        demagInterval: "",
        dtInitial: "",
        dtMax: "1e-15",
        dtMin: "1e-14",
        energyTolerance: "",
        fixDt: "",
        integrator: "rk45",
        maxErr: "1e-6",
        maxRelaxSteps: "",
        relaxAlgorithm: "",
        timestepMode: "adaptive_max_error",
        torqueTolerance: "",
      },
      }).map((issue) => issue.message),
    ).toEqual([
      "Backend is required.",
      "External field must contain three finite numbers.",
      "CPU threads must be a positive integer.",
      "Adaptive dt max must be greater than or equal to dt min.",
      "FEM demag policy must be a JSON object.",
    ]);
  });
});
