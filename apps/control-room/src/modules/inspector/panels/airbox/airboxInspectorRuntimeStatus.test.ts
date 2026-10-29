import { describe, expect, it } from "vitest";
import {
  shouldLoadRuntimeMeshManifest,
  shouldLoadRuntimeMeshSummary,
} from "@/kernel/resources/studyRuntimeResources";

import {
  airboxInspectorRuntimeStatusEquals,
  hasPublishedFemTopologyInspectionLane,
  isExplicitFdmAirboxRuntime,
  isExplicitFemAirboxRuntime,
  matchesAirboxTopologyIdentity,
  resolveAirboxInspectorLane,
  resolveAirboxInspectorAuthoringLane,
  selectAirboxInspectorRuntimeStatus,
  shouldLoadAirboxMeshManifest,
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
      authoring: { method: "fem", state: "known", reason: null },
      executionState: "unknown",
      capabilities: { explicit_topology: true },
      domain: {
        cell_count: undefined,
        discretization: "fem",
        generation_id: undefined,
      },
      resources: {
        domain_generation_id: undefined,
        mesh_build_revision: 7,
        mesh_revision: 8,
        topology_revision: undefined,
      },
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
    expect(airboxInspectorRuntimeStatusEquals(left, { ...left!, executionState: "running" })).toBe(false);
    expect(
      airboxInspectorRuntimeStatusEquals(left, {
        ...left!,
        domain: { discretization: "fem" },
      } as never),
    ).toBe(false);
    expect(
      airboxInspectorRuntimeStatusEquals(left, {
        ...left!,
        domain: { ...left!.domain, generation_id: "generation-next" },
      }),
    ).toBe(false);
    expect(
      airboxInspectorRuntimeStatusEquals(left, {
        ...left!,
        resources: { ...left!.resources, topology_revision: 3 },
      }),
    ).toBe(false);
  });

  it("does not collapse absent authored identity into an explicit null identity", () => {
    const legacy = selectAirboxInspectorRuntimeStatus({
      data: {
        capabilities: { explicit_topology: false, active_lane: { resolved: null } },
        domain: { discretization: "fdm" },
        resources: { mesh_build_revision: 0, mesh_revision: 0 },
      } as never,
    });
    const explicitNull = selectAirboxInspectorRuntimeStatus({
      data: {
        capabilities: { explicit_topology: false, active_lane: { authored: null, resolved: null } },
        domain: { discretization: "fdm" },
        resources: { mesh_build_revision: 0, mesh_revision: 0 },
      } as never,
    });

    const sameDescription = { method: null, state: "missing", reason: null } as const;
    expect(airboxInspectorRuntimeStatusEquals(
      { ...legacy!, authoring: sameDescription },
      { ...explicitNull!, authoring: sameDescription },
    )).toBe(false);
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

  it("opens only the read-only FEM topology lane for a matching published unresolved artifact", () => {
    const status = selectAirboxInspectorRuntimeStatus({
      data: {
        capabilities: {
          explicit_topology: false,
          active_lane: {
            authored: { discretization: "fem" },
            resolved: null,
          },
        },
        domain: {
          cell_count: 24,
          discretization: "fem",
          generation_id: "generation-7",
        },
        resources: {
          domain_generation_id: "generation-7",
          mesh_build_revision: 0,
          mesh_revision: 11,
          topology_revision: 12,
        },
      } as never,
    });

    expect(isExplicitFemAirboxRuntime(status)).toBe(false);
    expect(hasPublishedFemTopologyInspectionLane(status)).toBe(true);
    expect(shouldLoadAirboxMeshManifest(true, status)).toBe(true);
    expect(matchesAirboxTopologyIdentity(status, {
      generation_id: "generation-7",
      revision: 11,
    } as never)).toBe(true);
    expect(matchesAirboxTopologyIdentity(status, {
      generation_id: "generation-6",
      revision: 11,
    } as never)).toBe(false);
    expect(matchesAirboxTopologyIdentity(status, {
      generation_id: "generation-7",
      revision: 10,
    } as never)).toBe(false);
  });

  it.each([
    { generation_id: "generation-6", cell_count: 24, mesh_revision: 11, topology_revision: 12 },
    { generation_id: "generation-7", cell_count: 0, mesh_revision: 11, topology_revision: 12 },
    { generation_id: "generation-7", cell_count: 24, mesh_revision: 0, topology_revision: 12 },
    { generation_id: "generation-7", cell_count: 24, mesh_revision: 11, topology_revision: 0 },
  ])("rejects incomplete or conflicting FEM artifact identity %#", (identity) => {
    const status = selectAirboxInspectorRuntimeStatus({
      data: {
        capabilities: {
          explicit_topology: false,
          active_lane: { authored: { discretization: "fem" }, resolved: null },
        },
        domain: {
          cell_count: identity.cell_count,
          discretization: "fem",
          generation_id: identity.generation_id,
        },
        resources: {
          domain_generation_id: "generation-7",
          mesh_build_revision: 0,
          mesh_revision: identity.mesh_revision,
          topology_revision: identity.topology_revision,
        },
      } as never,
    });

    expect(hasPublishedFemTopologyInspectionLane(status)).toBe(false);
    expect(shouldLoadAirboxMeshManifest(true, status)).toBe(false);
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
        authoring: { method: "fdm", state: "known", reason: null },
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
            authored: { discretization: "fem" },
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
    expect(resolveAirboxInspectorAuthoringLane({ kind: "universe.root" } as never, status)).toBe("fem");
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

  it("keeps a selected FDM Airbox target unresolved when live mode is unresolved", () => {
    const selection = {
      kind: "airbox.multilayer.target",
      ref: { type: "airbox", visualizationTargetId: "airbox" },
    } as never;
    const status = selectAirboxInspectorRuntimeStatus({
      data: {
        capabilities: { explicit_topology: false, active_lane: null },
        domain: { discretization: "fdm" },
        resources: { mesh_build_revision: 0, mesh_revision: 0 },
      } as never,
    });

    expect(resolveAirboxInspectorLane(selection, status)).toBe("unresolved");
  });

  it("keeps the multilayer target on the FDM lane even though its display target is Airbox", () => {
    const selection = {
      kind: "airbox.multilayer.target",
      ref: { type: "airbox", visualizationTargetId: "airbox" },
    } as never;
    const fdmStatus = {
      authoring: { method: "fdm", state: "known", reason: null },
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
      authoring: { method: "fdm", state: "known", reason: null },
      capabilities: { explicit_topology: true },
      domain: { discretization: "fdm" },
      resources: { mesh_build_revision: 4, mesh_revision: 5 },
    } as const;
    const femStatus = { ...fdmStatus, domain: { discretization: "fem" } } as const;

    expect(resolveAirboxInspectorLane(selection, fdmStatus)).toBe("fdm");
    expect(resolveAirboxInspectorLane(selection, femStatus)).toBe("fem");
  });
});
