import { describe, expect, it } from "vitest";

import {
  buildMeshEditorPatch,
  meshEditorCapabilityBlocks,
  resolveMeshEditorCapabilities,
  type MeshEditorDraft,
} from "./meshEditorCapabilityModel";

const supportedMatrix = {
  fdm: { status: "production_executable" },
  fem: { status: "partial_production_executable" },
  devices: {
    cpu: { status: "production_executable" },
    gpu: { status: "unsupported", reason: "CUDA mesh lane is not available." },
  },
  precision: {
    single: { status: "unsupported", reason: "FP32 mesh artifacts are not qualified." },
    double: { status: "production_executable" },
  },
  multilayer: { status: "unsupported", reason: "Multilayer mesh authoring is not advertised." },
  pbc: { status: "partial_production_executable" },
};

describe("meshEditorCapabilityModel", () => {
  it("normalizes server capability statuses and preserves reasons", () => {
    const model = resolveMeshEditorCapabilities({
      mesh_capabilities: supportedMatrix,
      mesh_adaptivity_state: null,
    });

    expect(model.option("fdm")).toMatchObject({
      enabled: true,
      status: "production_executable",
    });
    expect(model.option("gpu")).toMatchObject({
      enabled: false,
      reason: "CUDA mesh lane is not available.",
    });
    expect(model.option("single")).toMatchObject({
      enabled: false,
      reason: "FP32 mesh artifacts are not qualified.",
    });
    expect(model.option("pbc").enabled).toBe(true);
  });

  it("fails closed when the capability resource is absent", () => {
    const model = resolveMeshEditorCapabilities(null);

    expect(model.option("fem")).toMatchObject({
      enabled: false,
      status: "unavailable",
      reason: "Meshing capability resource is unavailable.",
    });
    expect(meshEditorCapabilityBlocks(model.option("fem"))).toBe(false);
  });

  it("does not block a legacy resource that has not published lane keys yet", () => {
    const model = resolveMeshEditorCapabilities({
      mesh_capabilities: { has_volume_mesh: true },
      mesh_adaptivity_state: null,
    });

    expect(model.option("fem").status).toBe("unavailable");
    expect(meshEditorCapabilityBlocks(model.option("fem"))).toBe(false);
  });

  it("rejects an unsupported draft before creating a canonical patch", () => {
    const model = resolveMeshEditorCapabilities({
      mesh_capabilities: supportedMatrix,
      mesh_adaptivity_state: null,
    });
    const draft: MeshEditorDraft = {
      discretization: "fdm",
      device: "gpu",
      precision: "double",
      multilayer: false,
      periodic: true,
    };

    expect(buildMeshEditorPatch(draft, model)).toEqual({
      error: "CUDA mesh lane is not available.",
    });
  });

  it("exports a canonical patch for an advertised draft", () => {
    const model = resolveMeshEditorCapabilities({
      mesh_capabilities: {
        fdm: { status: "production_executable" },
        cpu: { status: "reference_executable" },
        double: { status: "validated" },
        pbc: { status: "partial_production_executable" },
      },
      mesh_adaptivity_state: null,
    });

    expect(
      buildMeshEditorPatch(
        {
          discretization: "fdm",
          device: "cpu",
          precision: "double",
          multilayer: false,
          periodic: true,
        },
        model,
      ),
    ).toEqual({
      patch: {
        discretization: "fdm",
        device: "cpu",
        precision: "double",
        multilayer: false,
        pbc: { enabled: true },
      },
    });
  });
});
