import { describe, expect, it } from "vitest";

import {
  buildStatusBarEngineModel,
  formatRuntimeBundleVersionLabel,
} from "./statusBarModel";

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

  it("marks the resolved engine as active while the solver is running", () => {
    const model = buildStatusBarEngineModel(
      {
        requested_backend: "fem",
        requested_device: "cpu",
        resolved_backend: "fem",
        resolved_device: "cpu",
        resolved_engine_id: "fem_cpu_native",
        resolved_runtime_family: "fem-cpu-native",
      },
      "running",
    );

    expect(model).toMatchObject({
      detail: "native MFEM/hypre",
      label: "FEM CPU",
      state: "active",
    });
  });

  it("falls back to requested execution while a run is unresolved", () => {
    const model = buildStatusBarEngineModel({
      requested_backend: "fem",
      requested_device: "gpu",
    });

    expect(model).toMatchObject({
      detail: "resolution pending",
      label: "FEM GPU",
      state: "pending",
    });
  });

  it("shows auto runtime selection as pending instead of AUTO AUTO unresolved runtime", () => {
    const model = buildStatusBarEngineModel({
      requested_backend: "auto",
      requested_device: "auto",
    });

    expect(model).toMatchObject({
      detail: "selection pending",
      label: "Runtime auto",
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

  it("labels backend build dates explicitly", () => {
    expect(formatRuntimeBundleVersionLabel("2026-05-18")).toBe(
      "Backend built 2026-05-18",
    );
  });
});
