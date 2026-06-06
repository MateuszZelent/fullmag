import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  buildStatusBarEngineModel,
  buildStatusBarMeshModel,
  formatRuntimeBundleVersionLabel,
} from "./statusBarModel";

const statusBarModuleSource = readFileSync(
  new URL("./StatusBarModule.tsx", import.meta.url),
  "utf8",
);

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

  it("keeps the resolved engine non-active while runtime waits for compute", () => {
    const model = buildStatusBarEngineModel(
      {
        requested_backend: "fem",
        requested_device: "cpu",
        resolved_backend: "fem",
        resolved_device: "cpu",
        resolved_engine_id: "fem_cpu_native",
        resolved_runtime_family: "fem-cpu-native",
      },
      "waiting_for_compute",
    );

    expect(model).toMatchObject({
      detail: "native MFEM/hypre",
      label: "FEM CPU",
      state: "resolved",
    });
  });

  it("uses detailed solver status for the visible runtime state", () => {
    expect(statusBarModuleSource).toContain("useSolverStatusResource");
    expect(statusBarModuleSource).toContain("resolveEffectiveRuntimeState");
    expect(statusBarModuleSource).toContain("formatRuntimeStateLabel");
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

  it("shows native fallback resolution instead of hiding the requested GPU miss", () => {
    const model = buildStatusBarEngineModel({
      requested_backend: "fem",
      requested_device: "gpu",
      resolved_backend: "fem",
      resolved_device: "cpu",
      resolved_engine_id: "fem_cpu_native",
      resolved_runtime_family: "fem-cpu-native",
      resolved_fallback: {
        occurred: true,
        original_engine: "fem_native_gpu",
        fallback_engine: "fem_cpu_native",
        reason: "native_fem_gpu_unavailable",
        message: "native FEM GPU unavailable; using native CPU FEM",
      },
    });

    expect(model).toMatchObject({
      detail: "fallback to native MFEM/hypre",
      label: "FEM CPU",
      state: "resolved",
    });
    expect(model.title).toContain("requested_device=gpu");
    expect(model.title).toContain("resolved_device=cpu");
    expect(model.title).toContain("original_engine=fem_native_gpu");
    expect(model.title).toContain("fallback_engine=fem_cpu_native");
    expect(model.title).toContain("reason=native_fem_gpu_unavailable");
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

  it("summarizes current and stale mesh revisions for the status bar", () => {
    expect(
      buildStatusBarMeshModel({
        manifestSourceSceneRevision: 44,
        meshBuildRevision: 57,
        meshRevision: 42,
        sceneRevision: 44,
      }),
    ).toMatchObject({
      label: "Mesh rev 42 | build rev 57 | current",
      state: "current",
    });

    expect(
      buildStatusBarMeshModel({
        manifestSourceSceneRevision: 40,
        meshBuildRevision: 57,
        meshRevision: 42,
        sceneRevision: 44,
      }),
    ).toMatchObject({
      label: "Mesh rev 42 | scene rev 44 | stale",
      state: "stale",
    });
  });

  it("summarizes missing and active mesh builds for the status bar", () => {
    expect(
      buildStatusBarMeshModel({
        meshBuildRevision: 0,
        meshRevision: 0,
        sceneRevision: 3,
      }),
    ).toMatchObject({
      label: "Mesh not built",
      state: "not-built",
    });

    expect(
      buildStatusBarMeshModel({
        activeBuildStatus: "running",
        meshBuildRevision: 58,
        meshRevision: 42,
        sceneRevision: 44,
      }),
    ).toMatchObject({
      label: "Mesh rev 42 | build rev 58 | building",
      state: "building",
    });
  });
});
