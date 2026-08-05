import { describe, expect, it } from "vitest";
import type { ActiveLaneCapabilitySnapshot } from "@/kernel/resources/useActiveLaneCapabilities";

import {
  buildStudyGlobalMergePatch,
  createStudyGlobalDraft,
  isExplicitFdmStudy,
  normalizeDemagRealizationForLane,
  validateStudyGlobalDraft,
} from "./StudyGlobalAuthoringModel";

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
    backend: "fdm",
    device,
    discretization: "fdm",
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
      engine_id: "test-fdm",
      authored_intent: "problem_ir.runtime_selection",
      effective_request: "session.runtime_resolution",
    },
    qualification: { status: "not_asserted", reason: "Test fixture." },
    operations,
  };
}

describe("StudyGlobalAuthoringModel", () => {
  it.each([
    ["cpu", "double", "strict"],
    ["gpu", "single", "extended"],
  ])(
    "trusts planner global-study operation state on %s/%s/%s",
    (device, precision, mode) => {
      const draft = createStudyGlobalDraft({
        study: {
          requested_backend: "fdm",
          requested_device: device,
          requested_mode: mode,
          requested_precision: precision,
        },
      });
      const activeLane = activeLaneSnapshot({
        device,
        mode,
        precision,
        operations: {
          "study.relaxation": {
            state: "supported",
            reason_code: "capability_supported",
            reason: "Relaxation is supported for this resolved lane.",
            requires: [],
          },
          "study.time_integration": {
            state: "supported",
            reason_code: "capability_supported",
            reason: "Time integration is supported for this resolved lane.",
            requires: [],
          },
        },
      });

      expect(
        validateStudyGlobalDraft(draft, { activeLane }).filter((issue) =>
          issue.message.includes("resolved lane"),
        ),
      ).toEqual([]);
    },
  );

  it("fails closed when the global draft has no active-lane capability snapshot", () => {
    const draft = createStudyGlobalDraft({ study: {} });

    expect(validateStudyGlobalDraft(draft, { activeLane: null })).toContainEqual({
      message: "Active-lane capability snapshot is unavailable.",
      severity: "error",
    });
  });

  it("recognizes only an explicit FDM request or session discretization", () => {
    expect(
      isExplicitFdmStudy({
        requestedBackend: "fdm",
        sessionDiscretization: "fem",
      }),
    ).toBe(true);
    expect(
      isExplicitFdmStudy({
        requestedBackend: "auto",
        sessionDiscretization: "fdm",
      }),
    ).toBe(true);
    expect(
      isExplicitFdmStudy({
        requestedBackend: "auto",
        sessionDiscretization: "auto",
      }),
    ).toBe(false);
    expect(
      isExplicitFdmStudy({
        requestedBackend: "fem",
        sessionDiscretization: "fem",
      }),
    ).toBe(false);
  });

  it("prioritizes an explicit requested backend over stale resolved session state", () => {
    expect(
      isExplicitFdmStudy({
        requestedBackend: "fem",
        sessionDiscretization: "fdm",
      }),
    ).toBe(false);
    expect(
      isExplicitFdmStudy({
        requestedBackend: "fdm",
        sessionDiscretization: "fem",
      }),
    ).toBe(true);
  });

  it("prioritizes an explicit requested discretization over stale resolved session state", () => {
    expect(
      isExplicitFdmStudy({
        requestedBackend: "auto",
        requestedDiscretization: "fem",
        sessionDiscretization: "fdm",
      }),
    ).toBe(false);
    expect(
      isExplicitFdmStudy({
        requestedBackend: "auto",
        requestedDiscretization: "fdm",
        sessionDiscretization: "fem",
      }),
    ).toBe(true);
  });

  it("lets hybrid backend intent defer to requested or resolved discretization", () => {
    expect(
      isExplicitFdmStudy({
        requestedBackend: "hybrid",
        requestedDiscretization: "fdm",
        sessionDiscretization: "fem",
      }),
    ).toBe(true);
    expect(
      isExplicitFdmStudy({
        requestedBackend: "hybrid",
        requestedDiscretization: "fem",
        sessionDiscretization: "fdm",
      }),
    ).toBe(false);
    expect(
      isExplicitFdmStudy({
        requestedBackend: "hybrid",
        sessionDiscretization: "fdm",
      }),
    ).toBe(true);
    expect(
      isExplicitFdmStudy({
        requestedBackend: "hybrid",
        sessionDiscretization: "fem",
      }),
    ).toBe(false);
  });

  it("falls through auto and remains unresolved without any concrete lane", () => {
    expect(
      isExplicitFdmStudy({
        requestedBackend: "auto",
        requestedDiscretization: undefined,
        sessionDiscretization: "fdm",
      }),
    ).toBe(true);
    expect(isExplicitFdmStudy({})).toBe(false);
  });

  it("does not serialize the FEM solver policy for an explicit FDM study", () => {
    const request = buildStudyGlobalMergePatch(
      {
        ...createStudyGlobalDraft({
          study: {
            requested_backend: "auto",
            fem_demag_solver_policy: { solver: "CG" },
          },
        }),
        demagRealization: "multilayer_convolution",
      },
      { sessionDiscretization: "fdm" },
    );
    expect(request.kind).toBe("merge_patch");
    if (request.kind !== "merge_patch") throw new Error("expected merge patch");
    expect(request.merge_patch.study).toMatchObject({
      demag_realization: "multilayer_convolution",
      fem_demag_solver_policy: null,
    });
  });

  it("normalizes a stale FDM strategy when an auto request resolves to FEM", () => {
    const draft = {
      ...createStudyGlobalDraft({
        study: {
          requested_backend: "auto",
          demag_realization: "multilayer_convolution",
          fem_demag_solver_policy: { solver: "CG" },
        },
      }),
      demagRealization: "single_grid",
    };
    const request = buildStudyGlobalMergePatch(draft, {
      sessionDiscretization: "fem",
    });
    expect(request.kind).toBe("merge_patch");
    if (request.kind !== "merge_patch") throw new Error("expected merge patch");
    expect(request.merge_patch.study).toMatchObject({
      demag_realization: "auto",
      fem_demag_solver_policy: { solver: "CG" },
    });
    expect(
      normalizeDemagRealizationForLane("multilayer_convolution", {
        requestedBackend: "auto",
        sessionDiscretization: "fem",
      }),
    ).toBe("auto");
  });

  it("honors requestedDiscretization when no backend field is explicit", () => {
    const draft = {
      ...createStudyGlobalDraft({
        study: { requested_backend: "auto" },
      }),
      demagRealization: "multilayer_convolution",
    };
    const request = buildStudyGlobalMergePatch(draft, {
      requestedDiscretization: "fdm",
      sessionDiscretization: "fem",
    });
    expect(request.kind).toBe("merge_patch");
    if (request.kind !== "merge_patch") throw new Error("expected merge patch");
    expect(request.merge_patch.study).toMatchObject({
      demag_realization: "multilayer_convolution",
    });
    expect(
      normalizeDemagRealizationForLane("single_grid", {
        requestedDiscretization: "fem",
      }),
    ).toBe("auto");
  });

  it("validates FDM demag strategies without applying FEM policy validation", () => {
    const draft = {
      ...createStudyGlobalDraft({ study: { requested_backend: "fdm" } }),
      demagRealization: "poisson_robin",
      femDemagSolverPolicy: "not-json",
    };
    expect(
      validateStudyGlobalDraft(draft, {
        algorithmsAvailable: [],
        sessionDiscretization: "fdm",
      }).map((issue) => issue.message),
    ).toEqual([
      "FDM demag realization must be auto, single_grid, or multilayer_convolution.",
    ]);
  });

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
            max_spin_rotation: 0.15,
            norm_tolerance: 2e-6,
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
        maxSpinRotation: "0.15",
        normTolerance: "0.000002",
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
          max_spin_rotation: 0.15,
          norm_tolerance: 2e-6,
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

  it("defaults advanced controller fields and fails closed for incomplete or unsupported execution", () => {
    const draft = createStudyGlobalDraft({
      study: {
        requested_backend: "fdm",
        requested_device: "gpu",
        requested_precision: "double",
        solver: {
          integrator: "rk45",
          adaptive_timestep: {
            atol: 1e-8,
            rtol: 1e-5,
            dt_min: 1e-16,
            dt_max: 1e-13,
          },
        },
      },
    });
    expect(draft.solver.adaptiveTimestep).toMatchObject({
      safety: "0.9",
      growthLimit: "2",
      shrinkLimit: "0.2",
    });
    expect(validateStudyGlobalDraft(draft, {
      algorithmsAvailable: ["llg_overdamped"],
    }).map((issue) => issue.message)).toContain(
      "Adaptive FDM execution requires an explicit CPU device.",
    );

    const incomplete = {
      ...draft,
      requestedDevice: "cpu",
      solver: {
        ...draft.solver,
        integrator: "heun",
        adaptiveTimestep: {
          ...draft.solver.adaptiveTimestep!,
          dtMax: "",
        },
      },
    };
    const messages = validateStudyGlobalDraft(incomplete).map((issue) => issue.message);
    expect(messages).toContain("Adaptive dt max must be finite and positive.");
    expect(messages).toContain("Adaptive policy requires RK23 or RK45.");

    const invalidGuards = {
      ...draft,
      requestedDevice: "cpu",
      solver: {
        ...draft.solver,
        adaptiveTimestep: {
          ...draft.solver.adaptiveTimestep!,
          maxSpinRotation: "0",
          normTolerance: "Infinity",
        },
      },
    };
    const guardMessages = validateStudyGlobalDraft(invalidGuards).map((issue) => issue.message);
    expect(guardMessages).toContain("Max spin rotation must be finite and positive.");
    expect(guardMessages).toContain("Norm tolerance must be finite and positive.");
  });

  it("rejects adaptive single precision even on an explicit FDM CPU lane", () => {
    const draft = createStudyGlobalDraft({
      study: {
        requested_backend: "fdm",
        requested_device: "cpu",
        requested_precision: "single",
        solver: {
          integrator: "rk45",
          dt_min: 1e-16,
          dt_max: 1e-13,
          max_err: 1e-6,
        },
      },
    });

    expect(
      validateStudyGlobalDraft(draft, {
        algorithmsAvailable: ["llg_overdamped"],
      }).map((issue) => issue.message),
    ).toContain("Adaptive execution is qualified only for double precision.");
  });
});
