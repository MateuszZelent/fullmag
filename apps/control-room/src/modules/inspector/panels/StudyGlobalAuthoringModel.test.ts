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
      solver: '{"integrator":"rk45"}',
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
        solver: '{"integrator":"rk45"}',
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
          solver: { integrator: "rk45" },
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
      solver: "",
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
        solver: "{bad",
      }).map((issue) => issue.message),
    ).toEqual([
      "Backend is required.",
      "External field must contain three finite numbers.",
      "CPU threads must be a positive integer.",
      "Solver must be a JSON object.",
      "FEM demag policy must be a JSON object.",
    ]);
  });
});
