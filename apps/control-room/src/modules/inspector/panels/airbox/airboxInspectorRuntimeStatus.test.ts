import { describe, expect, it } from "vitest";
import {
  shouldLoadRuntimeMeshManifest,
  shouldLoadRuntimeMeshSummary,
} from "@/kernel/resources/studyRuntimeResources";

import {
  airboxInspectorRuntimeStatusEquals,
  isExplicitFdmAirboxRuntime,
  isExplicitFemAirboxRuntime,
  resolveAirboxInspectorLane,
  selectAirboxInspectorRuntimeStatus,
} from "./airboxInspectorRuntimeStatus";

describe("airboxInspectorRuntimeStatus", () => {
  it("selects only the runtime fields used by mesh resource gates", () => {
    expect(
      selectAirboxInspectorRuntimeStatus({
        data: {
          capabilities: { explicit_topology: true },
          domain: { discretization: "fem" },
          resources: { mesh_build_revision: 7, mesh_revision: 8 },
        },
      } as never),
    ).toEqual({
      capabilities: { explicit_topology: true },
      domain: { discretization: "fem" },
      resources: { mesh_build_revision: 7, mesh_revision: 8 },
    });
  });

  it("returns null without status and compares selected snapshots structurally", () => {
    expect(selectAirboxInspectorRuntimeStatus({ data: null } as never)).toBeNull();
    const left = selectAirboxInspectorRuntimeStatus({
      data: {
        capabilities: { explicit_topology: false },
        domain: { discretization: "fdm" },
        resources: { mesh_build_revision: null, mesh_revision: null },
      },
    } as never);
    expect(airboxInspectorRuntimeStatusEquals(left, { ...left! })).toBe(true);
    expect(
      airboxInspectorRuntimeStatusEquals(left, {
        ...left!,
        domain: { discretization: "fem" },
      } as never),
    ).toBe(false);
  });

  it("keeps summary and manifest resources disabled until runtime evidence exists", () => {
    expect(shouldLoadRuntimeMeshSummary(true, null)).toBe(false);
    expect(shouldLoadRuntimeMeshManifest(true, null)).toBe(false);

    const unavailable = {
      capabilities: { explicit_topology: true },
      domain: { discretization: "fem" },
      resources: { mesh_build_revision: 0, mesh_revision: 0 },
    };
    expect(shouldLoadRuntimeMeshSummary(true, unavailable)).toBe(false);
    expect(shouldLoadRuntimeMeshManifest(true, unavailable)).toBe(false);

    const available = {
      ...unavailable,
      resources: { mesh_build_revision: 2, mesh_revision: 3 },
    };
    expect(shouldLoadRuntimeMeshSummary(true, available)).toBe(true);
    expect(shouldLoadRuntimeMeshManifest(true, available)).toBe(true);
  });

  it("treats only an explicit current FDM lane as FDM Airbox semantics", () => {
    expect(isExplicitFdmAirboxRuntime(null)).toBe(false);
    expect(
      isExplicitFdmAirboxRuntime({
        capabilities: { explicit_topology: false },
        domain: { discretization: "" },
        resources: { mesh_build_revision: null, mesh_revision: null },
      } as never),
    ).toBe(false);
    expect(
      isExplicitFdmAirboxRuntime({
        capabilities: { explicit_topology: true },
        domain: { discretization: "FDM" },
        resources: { mesh_build_revision: 4, mesh_revision: 5 },
      }),
    ).toBe(true);
  });

  it("uses the resolved active lane when an empty FEM domain still reports the default FDM domain", () => {
    const status = selectAirboxInspectorRuntimeStatus({
      data: {
        capabilities: {
          explicit_topology: false,
          active_lane: {
            resolved: { discretization: "fem" },
          },
        },
        domain: { discretization: "fdm" },
        resources: { mesh_build_revision: 0, mesh_revision: 0 },
      } as never,
    });
    expect(
      isExplicitFdmAirboxRuntime(status),
    ).toBe(false);
    expect(isExplicitFemAirboxRuntime(status)).toBe(true);
  });

  it("does not infer an Airbox lane from requested FEM when resolution is absent", () => {
    const status = selectAirboxInspectorRuntimeStatus({
      data: {
        capabilities: {
          explicit_topology: false,
          active_lane: {
            requested: { discretization: "fem" },
            resolved: null,
          },
        },
        domain: { discretization: "fdm" },
        resources: { mesh_build_revision: 0, mesh_revision: 0 },
      } as never,
    });

    expect(isExplicitFdmAirboxRuntime(status)).toBe(false);
    expect(isExplicitFemAirboxRuntime(status)).toBe(false);
  });

  it("fails closed when the active lane field is present but null", () => {
    const status = selectAirboxInspectorRuntimeStatus({
      data: {
        capabilities: {
          explicit_topology: false,
          active_lane: null,
        },
        domain: { discretization: "fdm" },
        resources: { mesh_build_revision: 0, mesh_revision: 0 },
      } as never,
    });

    expect(isExplicitFdmAirboxRuntime(status)).toBe(false);
    expect(isExplicitFemAirboxRuntime(status)).toBe(false);
  });

  it("keeps the multilayer target on the FDM lane even though its display target is Airbox", () => {
    const selection = {
      kind: "airbox.multilayer.target",
      ref: { type: "airbox", visualizationTargetId: "airbox" },
    } as never;
    const fdmStatus = {
      capabilities: { explicit_topology: true },
      domain: { discretization: "fdm" },
      resources: { mesh_build_revision: 4, mesh_revision: 5 },
    } as const;
    const femStatus = { ...fdmStatus, domain: { discretization: "fem" } } as const;

    expect(resolveAirboxInspectorLane(selection, fdmStatus)).toBe("fdm");
    expect(resolveAirboxInspectorLane(selection, femStatus)).toBe("conflict");
  });

  it("resolves a generic Airbox display target from the explicit runtime lane", () => {
    const selection = {
      kind: "airbox.visualization",
      ref: { type: "airbox", visualizationTargetId: "airbox" },
    } as never;
    const fdmStatus = {
      capabilities: { explicit_topology: true },
      domain: { discretization: "fdm" },
      resources: { mesh_build_revision: 4, mesh_revision: 5 },
    } as const;
    const femStatus = { ...fdmStatus, domain: { discretization: "fem" } } as const;

    expect(resolveAirboxInspectorLane(selection, fdmStatus)).toBe("fdm");
    expect(resolveAirboxInspectorLane(selection, femStatus)).toBe("fem");
  });
});
