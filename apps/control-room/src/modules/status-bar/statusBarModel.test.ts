import { describe, expect, it } from "vitest";

import { buildStatusBarEngineModel } from "./statusBarModel";

describe("statusBarModel", () => {
  it("labels the managed native FEM CPU engine as MFEM/hypre", () => {
    const model = buildStatusBarEngineModel({
      requested_backend: "fem",
      requested_device: "cpu",
      resolved_backend: "fem",
      resolved_device: "cpu",
      resolved_engine_id: "fem_cpu_native",
      resolved_runtime_family: "fem-cpu-native",
    });

    expect(model).toMatchObject({
      detail: "native MFEM/hypre",
      label: "FEM CPU",
      state: "resolved",
    });
    expect(model.title).toContain("resolved_engine_id=fem_cpu_native");
  });

  it("falls back to requested execution while a run is unresolved", () => {
    const model = buildStatusBarEngineModel({
      requested_backend: "fem",
      requested_device: "gpu",
    });

    expect(model).toMatchObject({
      detail: "unresolved runtime",
      label: "FEM GPU",
      state: "pending",
    });
  });

  it("shows an explicit pending state when there is no current run", () => {
    const model = buildStatusBarEngineModel(null);

    expect(model).toMatchObject({
      detail: "awaiting run",
      label: "Engine pending",
      state: "pending",
    });
  });
});
